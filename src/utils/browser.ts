import { type BrowserContext, chromium, type Page } from 'patchright';

import {
  BROWSER_NAVIGATION_MIN_WAIT_MS,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  MAX_CONCURRENT_BROWSER_TABS,
  USE_HEADLESS_BROWSER,
} from 'src/utils/config.js';
import { terminal } from 'src/utils/terminal.js';

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

/** Navigate `page` to `url`, honoring the project-wide navigation settings:
 *
 * - Up to `BROWSER_NAVIGATION_TIMEOUT_MS` waiting for `'networkidle'`.
 * - At least `BROWSER_NAVIGATION_MIN_WAIT_MS` extra dwell time after the
 *   navigation resolves, so JS-heavy pages have a chance to finish their
 *   post-load rendering before the caller scrapes.
 *
 * Network/timeout errors from the initial `page.goto` are caught and logged
 * (mirroring the "proceed with whatever content loaded" convention every
 * scraping callsite already uses). The min-wait still runs even on timeout
 * — partial content is often usable.
 *
 * Returns the resolved `Response` from goto, or `null` if it errored. Most
 * callers don't need it. */
export async function goToPage(
  page: Page,
  url: string
): Promise<import('patchright').Response | null> {
  let response: import('patchright').Response | null = null;
  try {
    response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
    });
  } catch (err) {
    terminal.warn(
      `Timeout/network error loading ${url}: ${String(err)}; proceeding with whatever content loaded`
    );
  }

  if (BROWSER_NAVIGATION_MIN_WAIT_MS > 0) {
    await new Promise(resolve =>
      setTimeout(resolve, BROWSER_NAVIGATION_MIN_WAIT_MS)
    );
  }

  return response;
}

/**
 * Like `page.evaluate(fn, arg)`, but immune to the `__name is not defined`
 * crash caused by tsx/esbuild wrapping transpiled function declarations with
 * `__name(...)`. We stringify `fn`, drop it in an IIFE that declares `__name`
 * locally, and ship the whole thing as a string so the missing helper resolves
 * at eval-time. `arg` must be JSON-serializable.
 *
 * `options.timeoutMs`: cap the eval at `timeoutMs` milliseconds. On timeout
 * the page is closed (which kills the script context so a runaway page-side
 * script stops eating CPU) and the call rejects with a clear error. The
 * surrounding `withBrowserTab` will then try `page.close()` again on its
 * way out — patchright treats double-close as a no-op so this is safe, but
 * note that the page is no longer usable after a timeout. Omit `timeoutMs`
 * (or set it to 0) to keep the original wait-forever behavior.
 */
export class PageEvalTimeoutError extends Error {
  override name = 'PageEvalTimeoutError';
  constructor(public readonly timeoutMs: number) {
    super(`pageEval timed out after ${timeoutMs}ms`);
  }
}

export async function pageEval<T, A = undefined>(
  page: Page,
  fn: (arg: A) => T | Promise<T>,
  arg?: A,
  options?: { timeoutMs?: number }
): Promise<T> {
  const argSrc = arg === undefined ? 'undefined' : JSON.stringify(arg);
  const src = `(function () { var __name = function (f) { return f; }; return (${fn.toString()})(${argSrc}); })()`;
  const evalP = page.evaluate(src) as Promise<T>;

  const timeoutMs = options?.timeoutMs;
  if (!timeoutMs) return evalP;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutP = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Close the page to kill the script context. Fire-and-forget — the
      // rejection happens regardless of whether close succeeds.
      void page.close().catch(() => {
        // ignore — page may already be closing
      });
      reject(new PageEvalTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([evalP, timeoutP]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
