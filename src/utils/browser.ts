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
