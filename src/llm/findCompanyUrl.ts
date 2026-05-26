import type { BrowserContext } from 'patchright';
import * as v from 'valibot';

import { LLM_SOURCING_MODEL } from 'jobfinder.config.js';
import { normalizeJobSourceUrl } from 'src/db/normalizeJobSourceUrl.js';
import { Memory } from 'src/llm/base.js';
import { verifyCompanyMatch } from 'src/llm/verifyCompanyMatch.js';
import { FIND_COMPANY_URL_SYSTEM_PROMPT } from 'src/prompts/findCompanyUrl.js';
import { goToPage, pageEval, withBrowserTab } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';
import { webSearchBySerper } from 'src/llm/webSearchBySerper';

/** Enough attempts to recover from a single mis-resolved URL: the LLM
 * proposes a URL, the verifier rejects it, the LLM tries another with
 * disambiguating terms. */
const MAX_ATTEMPTS = 5;

export type CompanyEvaluation = {
  /** Hostname-only form (e.g. "acme.com"). Always present — if the LLM can't
   * produce a verifiable URL within `MAX_ATTEMPTS`, `findCompanyUrl` throws. */
  url: string;
  /** 2–4 sentence plain-English description of the company's business. */
  summary: string;
  /** Number in [0, 1] — how likely the user is interested in working at this
   * company, per the interests text passed in. */
  interestScore: number;
  /** Short single-sentence justification of `interestScore`. */
  interestScoreReason: string;
};

/** Ask the LLM (with web search) for a company's URL + summary +
 * user-interest score, with in-loop verification: each candidate URL is
 * opened in the browser and a separate LLM call checks the page body
 * against the summary. A mismatch fails the validate step, which feeds
 * back into the same `Memory` so the LLM sees its rejected attempts and
 * can refine on the next try. */
export async function findCompanyUrl(args: {
  name: string;
  interests: string;
  context: BrowserContext;
}): Promise<CompanyEvaluation> {
  const { name, interests, context } = args;
  const memory = new Memory([{ system: FIND_COMPANY_URL_SYSTEM_PROMPT }]);

  const { result } = await webSearchBySerper({
    context,
    memory,
    initialPrompt: `User interests:

${interests || '(empty — score 0.0 with reason "no user interests provided")'}

Company name: ${name}`,
    schema: v.object({
      url: v.pipe(
        v.string(),
        v.description(
          'Primary corporate website URL of the company (e.g. "https://acme.com"). Non-empty. If web_search comes up empty, broaden the query and try again — do NOT return an empty string.'
        )
      ),
      summary: v.pipe(
        v.string(),
        v.description(
          "2–4 sentences in plain English describing the company's business: what it sells, who buys it, rough scale, distinguishing facts. Neutral and factual, not marketing copy."
        )
      ),
      interestScore: v.pipe(
        v.number(),
        v.description(
          'Score in [0, 1] of how likely the user would be interested in working at this company, judged against the User interests block.'
        )
      ),
      interestScoreReason: v.pipe(
        v.string(),
        v.description(
          'One sentence (≤ ~200 chars) justifying interestScore, citing concrete words from both the user interests and what you know about the company.'
        )
      ),
    }),
    maxAttempts: MAX_ATTEMPTS,
    model: LLM_SOURCING_MODEL,
    metadata: { configKey: 'LLM_SOURCING_MODEL' },
    logger: terminal,
    validate: async parsed => {
      if (parsed.interestScore < 0 || parsed.interestScore > 1) {
        return {
          valid: false,
          feedback: `interestScore must be in [0, 1]; got ${parsed.interestScore}.`,
        };
      }

      if (!parsed.interestScoreReason.trim()) {
        return {
          valid: false,
          feedback:
            'interestScoreReason must be a non-empty single sentence — cite concrete words from the user interests and what you know about the company.',
        };
      }

      if (!parsed.summary.trim()) {
        return {
          valid: false,
          feedback:
            "summary must not be empty — write 2–4 sentences describing the company's business. If you don't know the company, call web_search first.",
        };
      }

      const baseResult = {
        summary: parsed.summary.trim(),
        interestScore: parsed.interestScore,
        interestScoreReason: parsed.interestScoreReason.trim(),
      };

      const rawUrl = parsed.url.trim();
      if (!rawUrl) {
        return {
          valid: false,
          feedback:
            'You must return a non-empty url. If web_search came up empty, broaden the query (industry, city, founder name, flagship product, etc.) and try again — do NOT give up by returning an empty string.',
        };
      }

      const hostname = normalizeJobSourceUrl(rawUrl);
      if (!hostname) {
        return {
          valid: false,
          feedback: `You returned url="${rawUrl}" but it doesn't parse as a hostname. Return a clean URL like "https://acme.com".`,
        };
      }

      // Verify by opening the page and asking a separate (fresh-memory)
      // LLM call whether the body text matches the summary. Mismatch =>
      // feedback into THIS loop so the LLM sees its rejected URL in
      // conversation history and refines its next search.
      const pageText = await fetchPageInnerText(context, hostname);
      const match = await verifyCompanyMatch({
        summary: baseResult.summary,
        pageText,
      });

      if (!match.isTheSameCompany) {
        return {
          valid: false,
          feedback: `The url "${hostname}" you returned is NOT the right company. After opening the page, a verifier compared the body text to your summary and concluded: ${match.reason}. Pick a DIFFERENT url; refine your web_search query with disambiguating terms (industry, city, founder name, flagship product, etc.).`,
        };
      }

      return {
        valid: true,
        result: { url: hostname, ...baseResult },
      };
    },
  });

  terminal.log(
    `Identified URL for "${name}": ${result.url} (interestScore=${result.interestScore.toFixed(2)})`
  );

  return result;
}

async function fetchPageInnerText(
  context: BrowserContext,
  hostname: string
): Promise<string> {
  const url = `https://${hostname}`;
  try {
    return await withBrowserTab(context, async page => {
      await goToPage(page, url);
      try {
        return await pageEval<string>(
          page,
          () => {
            const { body } = document;
            return body ? body.innerText : '';
          },
          undefined,
          { timeoutMs: 10_000 }
        );
      } catch (err) {
        terminal.warn(`Failed to read body of ${url}: ${String(err)}`);
        return '';
      }
    });
  } catch (err) {
    terminal.warn(`Failed to open ${url}: ${String(err)}`);
    return '';
  }
}
