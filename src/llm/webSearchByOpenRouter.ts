import type * as v from 'valibot';

import { feedbackLoop, Memory, type ValidateResult } from 'src/llm/base.js';
import type { LlmReasoningEffort } from 'src/llm/plugins/interface.js';
import { terminal } from 'src/utils/terminal.js';

/**
 * Ask the LLM to answer `query` with the provider's native web-search tool
 * enabled, and return a typed response that matches `schema`. No browser
 * involved — the model itself decides whether to search and what to fetch.
 *
 * Wired through OpenRouter's `plugins: [{ id: 'web' }]` server tool (see
 * https://openrouter.ai/docs/guides/features/server-tools/web-search). The
 * Anthropic plugin currently rejects `enableWebSearch` with a clear error;
 * use a model routed via OpenRouter for now.
 *
 * Companion to {@link webSearchByGoogle}, which drives a Playwright tab to
 * google.com and feeds the SERP text to the LLM. Prefer this one — fewer
 * moving parts, no anti-bot risk. */
export async function webSearchByOpenRouter<
  S extends v.GenericSchema,
  R = v.InferOutput<S>,
>(args: {
  query: string;
  schema: S;
  /** System prompt describing what the LLM should produce from the web
   * search. Should make clear that the LLM may invoke its web_search tool
   * as many times as needed before answering. */
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
    query,
    schema,
    systemPrompt,
    model,
    validate,
    maxAttempts = 3,
    reasoningEffort,
    metadata,
  } = args;

  terminal.log(`LLM web search: "${query}"`);

  const memory = new Memory([{ system: systemPrompt }]);
  const { result } = await feedbackLoop<S, R>({
    memory,
    initialPrompt: `Web search query: ${query}

Use the web_search tool as many times as you need, then answer per the schema.`,
    schema,
    maxAttempts,
    model,
    logger: terminal,
    reasoningEffort,
    metadata,
    enableWebSearch: true,
    validate:
      validate ?? (parsed => ({ valid: true, result: parsed as unknown as R })),
  });

  return result;
}
