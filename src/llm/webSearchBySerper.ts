import { type BrowserContext } from 'patchright';
import * as v from 'valibot';

import { feedbackLoop, Memory, type ValidateResult } from 'src/llm/base.js';
import type { LlmReasoningEffort } from 'src/llm/plugins/interface.js';
import { goToPage, pageEval, withBrowserTab } from 'src/utils/browser.js';
import { Env } from 'src/utils/env.js';
import { type Terminal } from 'src/utils/terminal.js';

const SERPER_ENDPOINT = 'https://google.serper.dev/search';
const SERPER_TIMEOUT_MS = 30_000;

/** Hard cap on Serper calls per `webSearchBySerper` invocation — Serper is
 * rate-limited and metered, and a runaway agent re-searching every round is
 * the most common failure mode. Once hit, further "search" actions are
 * rejected and the LLM must "open" a prior result or "answer". */
const MAX_SERPER_CALLS = 5;

const AGENT_INSTRUCTIONS = `
You are a web-research agent answering one query. Each turn, choose ONE action:

- "search": run a Google search via the Serper API. Use this when you need new information you don't have yet.
- "open": fetch the readable text of a specific URL (e.g. a result from a prior search). Use this when a snippet looks promising but you need the full page.
- "answer": stop researching and return the final answer matching the schema.

Rules:
- Always include "reason" explaining what you learned and what you'll do next.
- Prefer "answer" the moment you have enough to answer confidently — every extra round costs time and money.
- When you "open" a URL, pick one that appeared in a prior Serper result whenever possible; do not invent URLs.
- If a tool round returns nothing useful, refine your search query rather than repeating the same one.`;

/**
 * Multi-round LLM web-research agent backed by Serper + Playwright. Drop-in
 * replacement for {@link feedbackLoop} when the answer needs live web data:
 * the interface matches `feedbackLoop` (same `memory`, `initialPrompt`,
 * `schema`, `validate`, return shape) plus a required `context` for the
 * Playwright tabs used to "open" URLs.
 *
 * Each round the LLM picks one of three actions:
 *  - `"search"` — issue a Google query via Serper; the raw JSON response is
 *    fed back as conversation feedback.
 *  - `"open"` — fetch the `innerText` of a URL it saw in prior results; the
 *    page text is fed back as conversation feedback.
 *  - `"answer"` — produce the final answer matching `schema` and end the
 *    loop. The caller's `validate` is then run on that answer.
 *
 * `maxAttempts` caps total iterations across all three action types. Each
 * Serper call is also capped per-invocation by `MAX_SERPER_CALLS`. When the
 * search budget is exhausted, the LLM is told to "open" a prior result or
 * "answer" with what it already has.
 *
 * Sibling of {@link webSearchByGoogle} (Playwright-driven Google scrape)
 * and {@link webSearchByLLM} (provider-native web-search tool). Prefer this
 * one when the answer requires cross-referencing multiple pages or
 * refining the query mid-flight.
 */
export async function webSearchBySerper<
  S extends v.GenericSchema,
  R = v.InferOutput<S>,
>(args: {
  /** Required for the "open" action — Playwright tabs are opened in this
   * browser context. */
  context: BrowserContext;
  memory: Memory;
  initialPrompt: string;
  /** Schema the LLM's final answer must match. */
  schema: S;
  /** Maximum tool-use rounds (search + open + answer combined). */
  maxAttempts: number;
  logger: Terminal;
  model: string;
  validate: (
    parsed: v.InferOutput<S>
  ) => Promise<ValidateResult<R>> | ValidateResult<R>;
  reasoningEffort?: LlmReasoningEffort;
  /** Forwarded verbatim to OpenRouter's `metadata` for cost analytics. */
  metadata?: Record<string, string>;
}): Promise<{ result: R; totalTokens: number }> {
  const {
    context,
    memory,
    initialPrompt,
    schema,
    maxAttempts,
    logger,
    model,
    validate,
    reasoningEffort,
    metadata,
  } = args;

  if (!Env.SERPER_API_KEY) {
    throw new Error(
      'SERPER_API_KEY is not set — populate it in .env.local or jobfinder.config.js.'
    );
  }

  // Step schema: a flat object with an `action` discriminator plus one field
  // per action. The caller's `schema` is nested under `answer` and is what
  // the caller's `validate` ultimately receives. Keeping it flat (rather
  // than a valibot discriminated union) makes the JSON-schema simpler for
  // the model to fill in correctly.
  const stepSchema = v.object({
    action: v.pipe(
      v.picklist(['search', 'open', 'answer']),
      v.description(
        'Pick exactly one: "search" to issue a Serper (Google) query; "open" to fetch a URL\'s readable text; "answer" when you can produce the final answer matching the schema.'
      )
    ),
    searchQuery: v.pipe(
      v.nullable(v.string()),
      v.description(
        'When action="search": the Google query string. Be specific — refine across rounds based on prior results. Null otherwise.'
      )
    ),
    url: v.pipe(
      v.nullable(v.string()),
      v.description(
        'When action="open": an absolute http(s) URL from prior search results (or a URL you have strong reason to think exists). Null otherwise.'
      )
    ),
    answer: v.pipe(
      v.nullable(schema),
      v.description(
        'When action="answer": the final answer, matching the requested schema exactly. Null otherwise.'
      )
    ),
    reason: v.pipe(
      v.string(),
      v.description(
        'One-sentence justification for this action (what you learned and what you plan to do).'
      )
    ),
  });

  let round = 0;
  let serperCalls = 0;
  return feedbackLoop({
    memory,
    initialPrompt: `${initialPrompt}\n\n${AGENT_INSTRUCTIONS}`,
    schema: stepSchema,
    maxAttempts,
    model,
    logger,
    reasoningEffort,
    metadata,
    validate: async parsed => {
      round += 1;

      logger.log(
        `webSearchBySerper round ${round}: action=${parsed.action} — ${parsed.reason}`
      );

      if (parsed.action === 'answer') {
        if (parsed.answer == null) {
          return {
            valid: false,
            feedback:
              'You set action="answer" but did not populate "answer". Either provide the final answer matching the schema, or choose a different action.',
          };
        }

        return await validate(parsed.answer);
      }

      if (parsed.action === 'search') {
        if (!parsed.searchQuery) {
          return {
            valid: false,
            feedback:
              'action="search" requires a non-empty "searchQuery". Provide a Google query string.',
          };
        }

        if (serperCalls >= MAX_SERPER_CALLS) {
          return {
            valid: false,
            feedback: `Search budget exhausted (${MAX_SERPER_CALLS}/${MAX_SERPER_CALLS} Serper calls used). No more "search" actions allowed this run — use "open" on a URL from a prior search result, or switch to "answer" with what you already have.`,
          };
        }

        serperCalls += 1;
        try {
          const results = await fetchSerper(parsed.searchQuery);
          return {
            valid: false,
            feedback: `Serper response for "${parsed.searchQuery}" (${serperCalls}/${MAX_SERPER_CALLS} searches used):\n\n${JSON.stringify(results, null, 2)}\n\nDecide your next action.`,
          };
        } catch (err) {
          return {
            valid: false,
            feedback: `Serper request for "${parsed.searchQuery}" failed: ${String(err)}. Try a different query, or switch to "answer" if you already have enough. (${serperCalls}/${MAX_SERPER_CALLS} searches used.)`,
          };
        }
      }

      // parsed.action === 'open'
      if (!parsed.url) {
        return {
          valid: false,
          feedback:
            'action="open" requires a non-empty "url" (absolute http(s) URL). Use a URL from a prior search result.',
        };
      }

      if (!/^https?:\/\//i.test(parsed.url)) {
        return {
          valid: false,
          feedback: `"url" must be an absolute http(s) URL; got "${parsed.url}". Use a URL from a prior search result.`,
        };
      }

      try {
        const text = await fetchPageInnerText(context, parsed.url);
        return {
          valid: false,
          feedback: `Page text from ${parsed.url} (innerText):\n\n${text}\n\nDecide your next action.`,
        };
      } catch (err) {
        return {
          valid: false,
          feedback: `Could not load ${parsed.url}: ${String(err)}. Try a different URL or refine your search.`,
        };
      }
    },
  });
}

/** POST `query` to the Serper API and return the raw JSON response.
 * Throws on HTTP failure / timeout — the agent loop's validator catches and
 * feeds the error back to the LLM as conversation feedback. */
async function fetchSerper(query: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERPER_TIMEOUT_MS);
  try {
    // Hand-rolled timeout via AbortController above replaces the
    // `fetchWithTimeout` helper the project lint rule normally requires.
    // eslint-disable-next-line no-restricted-globals
    const response = await fetch(SERPER_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-KEY': Env.SERPER_API_KEY!,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Serper request failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Open `url` in a fresh tab, return `document.body.innerText`. Throws on
 * navigation / evaluation failure — the agent loop's validator catches and
 * feeds the error back to the LLM as conversation feedback. */
async function fetchPageInnerText(
  context: BrowserContext,
  url: string
): Promise<string> {
  return withBrowserTab(context, async page => {
    await goToPage(page, url);
    return pageEval<string>(
      page,
      () => {
        const { body } = document;
        return body ? body.innerText : '';
      },
      undefined,
      { timeoutMs: 10_000 }
    );
  });
}
