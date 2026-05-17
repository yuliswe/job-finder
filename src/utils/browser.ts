import { type BrowserContext, chromium, type Page } from 'patchright';

import {
  MAX_CONCURRENT_BROWSER_TABS,
  USE_HEADLESS_BROWSER,
} from 'jobfinder.config.js';

/**
 * Launch a browser with a single shared context (so every tab opened via
 * `withBrowserTab` appears in the same window in headed mode), pass the
 * context to `fn`, and close both whether `fn` succeeds or throws.
 */
export async function withBrowserInstance<T>(
  fn: (context: BrowserContext) => Promise<T>
): Promise<T> {
  const browser = await chromium.launch({ headless: USE_HEADLESS_BROWSER });
  try {
    const context = await browser.newContext();
    try {
      return await fn(context);
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

let activeTabs = 0;
const tabWaiters: Array<() => void> = [];

async function acquireTab(): Promise<void> {
  if (activeTabs < MAX_CONCURRENT_BROWSER_TABS) {
    activeTabs++;
    return;
  }
  await new Promise<void>(resolve => {
    tabWaiters.push(() => {
      activeTabs++;
      resolve();
    });
  });
}

function releaseTab(): void {
  activeTabs--;
  const next = tabWaiters.shift();
  if (next) next();
}

/** Open a new tab in `context`, pass it to `fn`, and close it on completion. Caps concurrent tabs at MAX_CONCURRENT_BROWSER_TABS. */
export async function withBrowserTab<T>(
  context: BrowserContext,
  fn: (page: Page) => Promise<T>
): Promise<T> {
  await acquireTab();
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close();
    releaseTab();
  }
}

/**
 * Like `page.evaluate(fn, arg)`, but immune to the `__name is not defined`
 * crash caused by tsx/esbuild wrapping transpiled function declarations with
 * `__name(...)`. We stringify `fn`, drop it in an IIFE that declares `__name`
 * locally, and ship the whole thing as a string so the missing helper resolves
 * at eval-time. `arg` must be JSON-serializable.
 */
export async function pageEval<T, A = undefined>(
  page: Page,
  fn: (arg: A) => T | Promise<T>,
  arg?: A
): Promise<T> {
  const argSrc = arg === undefined ? 'undefined' : JSON.stringify(arg);
  const src = `(function () { var __name = function (f) { return f; }; return (${fn.toString()})(${argSrc}); })()`;
  return page.evaluate(src) as Promise<T>;
}
