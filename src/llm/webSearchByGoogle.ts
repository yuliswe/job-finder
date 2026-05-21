import { type BrowserContext } from 'patchright';
import type * as v from 'valibot';

import { feedbackLoop, Memory, type ValidateResult } from 'src/llm/base.js';
import type { LlmReasoningEffort } from 'src/llm/plugins/interface.js';
import { goToPage, withBrowserTab } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal';

/**
 * Open Google in a new tab of `context`, run a search for `query`, capture the
 * results page text, and pass it to the LLM to extract a typed response that
 * matches `schema`. Wrapped in `feedbackLoop`, so a custom `validate` can ask
 * the LLM to retry with corrective feedback.
 *
 * Companion to {@link webSearchByLLM}, which uses the provider's native
 * web-search tool (OpenRouter `plugins: [{id:'web'}]`) instead of driving a
 * real browser to google.com. Prefer the LLM variant when available — it
 * doesn't need a Playwright tab and tends to be both faster and less
 * blockable by Google's anti-bot heuristics.
 */
export async function webSearchByGoogle<
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
  /** Forwarded verbatim to OpenRouter's `metadata` for cost analytics. */
  metadata?: Record<string, string>;
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
    metadata,
  } = args;

  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;

  terminal.log(`Google search: "${query}"`);
  const { pageText, pageTitle } = await withBrowserTab(context, async page => {
    await goToPage(page, url);
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText);
    return { pageText: text, pageTitle: title };
  });

  const memory = new Memory([{ system: systemPrompt }]);
  const { result } = await feedbackLoop<S, R>({
    memory,
    initialPrompt: `Google search query: ${query}
Page title: ${pageTitle}

Search results page text (may include ads, snippets, and link text):
${pageText}`,
    schema,
    maxAttempts,
    model,
    logger: terminal,
    reasoningEffort,
    metadata,
    validate:
      validate ?? (parsed => ({ valid: true, result: parsed as unknown as R })),
  });

  return result;
}
