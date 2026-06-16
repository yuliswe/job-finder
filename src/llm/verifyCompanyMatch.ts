import * as v from 'valibot';

import { LLM_SOURCING_MODEL } from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { VERIFY_COMPANY_MATCH_SYSTEM_PROMPT } from 'src/prompts/verifyCompanyMatch.js';
import { terminal } from 'src/utils/terminal.js';

const MAX_ATTEMPTS = 2;

export type VerifyCompanyMatchResult = {
  isTheSameCompany: boolean;
  reason: string;
};

/** Ask the LLM to decide whether a webpage body matches the company a
 * summary describes. Fresh memory — no carry-over from the URL-discovery
 * call. */
export async function verifyCompanyMatch(args: {
  summary: string;
  pageText: string;
}): Promise<VerifyCompanyMatchResult> {
  const { summary, pageText } = args;
  const memory = new Memory([{ system: VERIFY_COMPANY_MATCH_SYSTEM_PROMPT }]);

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `Summary of the claimed company:

${summary}

Webpage body text (length ${pageText.length}):

${pageText || '(empty)'}`,
    schema: v.object({
      isTheSameCompany: v.pipe(
        v.boolean(),
        v.description(
          'true iff the webpage clearly represents the same company as the summary; false otherwise (including empty / parked / placeholder pages).'
        )
      ),
      reason: v.pipe(
        v.string(),
        v.description(
          'One sentence (≤ ~200 chars) citing concrete evidence from both the summary and the page body.'
        )
      ),
    }),
    maxAttempts: MAX_ATTEMPTS,
    models: LLM_SOURCING_MODEL,
    metadata: { configKey: 'LLM_SOURCING_MODEL' },
    logger: terminal,
    validate: async parsed => {
      if (!parsed.reason.trim()) {
        return {
          valid: false,
          feedback:
            'reason must be a non-empty single sentence citing what you saw in the summary vs. the page text.',
        };
      }

      return {
        valid: true,
        result: {
          isTheSameCompany: parsed.isTheSameCompany,
          reason: parsed.reason.trim(),
        },
      };
    },
  });

  return result;
}
