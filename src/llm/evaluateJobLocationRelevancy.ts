import * as v from 'valibot';

import { LLM_VIEWING_MODEL } from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { EVALUATE_JOB_LOCATION_RELEVANCY_SYSTEM_PROMPT } from 'src/prompts/evaluateJobLocationRelevancy.js';
import { terminal } from 'src/utils/terminal';

const MAX_ATTEMPTS = 2;

export type JobLocationRelevancy = {
  locationRelevancy: number;
  locationRelevancyReason: string;
};

/**
 * Ask the LLM how well a posting's location fits the user's location
 * preferences (as expressed in the interests file). Runs at viewing time,
 * right after the location + remote status have been extracted, so the score
 * can gate whether the post proceeds to `evaluate` (see `inScopeForEvaluate`
 * and `PIPELINE_VIEWING_MIN_LOCATION_RELEVANCY`).
 */
export async function evaluateJobLocationRelevancy(args: {
  interests: string;
  location: string | null;
  isRemote: boolean | null;
}): Promise<JobLocationRelevancy> {
  const { interests, location, isRemote } = args;

  const isRemoteLabel = isRemote === null ? 'unknown' : isRemote ? 'yes' : 'no';

  const memory = new Memory([
    { system: EVALUATE_JOB_LOCATION_RELEVANCY_SYSTEM_PROMPT },
  ]);

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `User interests:

${interests || '(empty)'}

Posting location: ${location || '(not given)'}
Is remote: ${isRemoteLabel}

Score how well this posting's location fits the user's stated location preference and return the structured result.`,
    schema: v.object({
      locationRelevancy: v.pipe(
        v.number(),
        v.description(
          "Score in [0, 1] of how well the posting's location (and remote status) fits the user's location preferences from the interests file. 0.5 when the posting's location is unknown or the user has no stated preference."
        )
      ),
      locationRelevancyReason: v.pipe(
        v.string(),
        v.description(
          "One sentence (≤ ~200 chars) justifying locationRelevancy, citing the user's stated location preference (or its absence) and the posting's location / remote status."
        )
      ),
    }),
    maxAttempts: MAX_ATTEMPTS,
    models: LLM_VIEWING_MODEL,
    metadata: { configKey: 'LLM_VIEWING_MODEL' },
    logger: terminal,
    validate: parsed => {
      if (parsed.locationRelevancy < 0 || parsed.locationRelevancy > 1) {
        return {
          valid: false,
          feedback: `locationRelevancy must be in [0, 1]; got ${parsed.locationRelevancy}. Clamp and resend.`,
        };
      }

      if (!parsed.locationRelevancyReason.trim()) {
        return {
          valid: false,
          feedback:
            'locationRelevancyReason must be a non-empty sentence citing the user-stated location preference (or its absence) and the posting location.',
        };
      }

      return { valid: true, result: parsed };
    },
  });

  return {
    locationRelevancy: result.locationRelevancy,
    locationRelevancyReason: result.locationRelevancyReason.trim(),
  };
}
