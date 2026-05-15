import { type BrowserContext } from 'patchright';
import type * as v from 'valibot';

import { BROWSER_NAVIGATION_TIMEOUT_MS } from 'jobfinder.config.js';
import { feedbackLoop, Memory, type ValidateResult } from 'src/llm/base.js';
import type { LlmReasoningEffort } from 'src/llm/plugins/interface.js';
import { withBrowserTab } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal';

const MAX_PAGE_TEXT_CHARS = 16_000;

/**
 * Open Google in a new tab of `context`, run a search for `query`, capture the
 * results page text, and pass it to the LLM to extract a typed response that
 * matches `schema`. Wrapped in `feedbackLoop`, so a custom `validate` can ask
 * the LLM to retry with corrective feedback.
 */
export async function webSearch<
  S extends v.GenericSchema,
  R = v.InferOutput<S>,
>(args: {
  context: BrowserContext;
  query: string;
  schema: S;
  /** System prompt describing what the LLM should extract from the page. */
  systemPrompt: string;
  model: string;
  maxAttempts?: number;
  reasoningEffort?: LlmReasoningEffort;
  /** Optional custom validator. Defaults to accepting any schema-parsed response. */
  validate?: (
    parsed: v.InferOutput<S>
  ) => ValidateResult<R> | Promise<ValidateResult<R>>;
}): Promise<R> {
  const {
    context,
    query,
    schema,
    systemPrompt,
    model,
    validate,
    maxAttempts = 3,
    reasoningEffort,
  } = args;

  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

  terminal.log(`Google search: "${query}"`);
  const { pageText, pageTitle } = await withBrowserTab(context, async page => {
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
    });
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText);
    return { pageText: text, pageTitle: title };
  });

  const truncated = pageText.slice(0, MAX_PAGE_TEXT_CHARS);

  const memory = new Memory([{ system: systemPrompt }]);
  const { result } = await feedbackLoop<S, R>({
    memory,
    initialPrompt: `Google search query: ${query}
Page title: ${pageTitle}

Search results page text (may include ads, snippets, and link text):
${truncated}`,
    schema,
    maxAttempts,
    model,
    logger: terminal,
    reasoningEffort,
    validate:
      validate ?? (parsed => ({ valid: true, result: parsed as unknown as R })),
  });

  return result;
}
