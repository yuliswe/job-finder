import * as v from 'valibot';

import { LLM_SOURCING_MODEL } from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { EVALUATE_COMPANY_SYSTEM_PROMPT } from 'src/prompts/evaluateCompany.js';
import { terminal } from 'src/utils/terminal.js';

const MAX_ATTEMPTS = 3;

export type CompanyResearch = {
  /** 2–4 sentence plain-English description of the company's business. */
  summary: string;
  /** Number in [0, 1]. */
  interestScore: number;
  /** Short single-sentence justification of `interestScore`. */
  interestScoreReason: string;
};

/** Ask the LLM (with web search) for a summary + user-interest score for a
 * company whose URL is already known. Use this when the JobSource already
 * has a `url` set and only the research fields need filling — sibling of
 * `findCompanyUrl`, but skips the URL-discovery step so a flaky web search
 * can't corrupt a previously-correct URL. */
export async function evaluateCompany(args: {
  name: string;
  url: string;
  interests: string;
}): Promise<CompanyResearch> {
  const { name, url, interests } = args;
  const memory = new Memory([{ system: EVALUATE_COMPANY_SYSTEM_PROMPT }]);

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `User interests:

${interests || '(empty — score 0.0 with reason "no user interests provided")'}

Company name: ${name}
Company URL: ${url}`,
    schema: v.object({
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
    enableWebSearch: true,
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

      return {
        valid: true,
        result: {
          summary: parsed.summary.trim(),
          interestScore: parsed.interestScore,
          interestScoreReason: parsed.interestScoreReason.trim(),
        },
      };
    },
  });

  terminal.log(
    `Evaluated "${name}" (${url}): interestScore=${result.interestScore.toFixed(2)}`
  );
  return result;
}
