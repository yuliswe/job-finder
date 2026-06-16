import * as v from 'valibot';

import { LLM_LISTING_MODEL } from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { EXTRACT_USER_FILTER_PREFS_SYSTEM_PROMPT } from 'src/prompts/extractUserFilterPrefs.js';
import { terminal } from 'src/utils/terminal';

const MAX_ATTEMPTS = 3;

export type UserFilterPrefs = {
  division: string;
  location: string;
};

/**
 * Ask the LLM to pull a `division` and `location` out of the user's
 * free-form interests text. Used by `pipeline run-scripts` to seed the
 * filter-mapping step when the user doesn't supply `-d`/`-l` flags.
 */
export async function extractUserFilterPrefs(args: {
  interests: string;
}): Promise<UserFilterPrefs> {
  const { interests } = args;
  if (!interests.trim()) {
    throw new Error(
      'Interests text is empty; cannot extract division/location.'
    );
  }

  const memory = new Memory([
    { system: EXTRACT_USER_FILTER_PREFS_SYSTEM_PROMPT },
  ]);

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `User interests:

${interests}

Extract \`division\` and \`location\` per the schema.`,
    schema: v.object({
      division: v.pipe(
        v.string(),
        v.description(
          'Department/function (e.g. "engineering", "design"). Must be non-empty.'
        )
      ),
      location: v.pipe(
        v.string(),
        v.description(
          'Geographic preference (e.g. "Waterloo, Ontario", "Remote"). Must be non-empty.'
        )
      ),
    }),
    maxAttempts: MAX_ATTEMPTS,
    models: LLM_LISTING_MODEL,
    metadata: { configKey: 'LLM_LISTING_MODEL' },
    logger: terminal,
    validate: parsed => {
      if (!parsed.division.trim()) {
        return {
          valid: false,
          feedback:
            'division was empty. Return a non-empty short noun phrase like "engineering".',
        };
      }

      if (!parsed.location.trim()) {
        return {
          valid: false,
          feedback:
            'location was empty. Return a non-empty short string like "Remote" or "Toronto, ON".',
        };
      }

      return {
        valid: true,
        result: {
          division: parsed.division.trim(),
          location: parsed.location.trim(),
        },
      };
    },
  });

  return result;
}
