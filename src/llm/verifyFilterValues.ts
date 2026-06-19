import * as v from 'valibot';

import { LLM_LISTING_MODEL } from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { VERIFY_FILTER_VALUES_SYSTEM_PROMPT } from 'src/prompts/verifyFilterValues.js';
import { terminal } from 'src/utils/terminal.js';

const MAX_ATTEMPTS = 2;

export type VerifyFilterValuesResult = {
  locationsArePlausible: boolean;
  locationsReason: string;
  divisionsArePlausible: boolean;
  divisionsReason: string;
};

/** Ask the LLM whether the strings the parser script's `listLocations()`
 * and `listDivisions()` returned look like real filter values or like
 * garbage (nav chrome, headings, URLs, etc.). Used as an extra sanity
 * gate inside `runProbes` so a bad selector trips immediate feedback
 * instead of polluting downstream stages.
 *
 * Both arrays are checked in a single LLM round-trip. Empty arrays are
 * trivially plausible. */
export async function verifyFilterValues(args: {
  locations: string[];
  divisions: string[];
}): Promise<VerifyFilterValuesResult> {
  const { locations, divisions } = args;

  const memory = new Memory([{ system: VERIFY_FILTER_VALUES_SYSTEM_PROMPT }]);

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `Locations (${locations.length}):
${locations.length === 0 ? '(empty)' : locations.map(s => `- ${s}`).join('\n')}

Divisions (${divisions.length}):
${divisions.length === 0 ? '(empty)' : divisions.map(s => `- ${s}`).join('\n')}

Classify each array.`,
    schema: v.object({
      locationsArePlausible: v.pipe(
        v.boolean(),
        v.description(
          'true iff the locations array looks like real location/city/region/country filter values (or is empty); false if the array is mostly nav chrome, headings, URLs, generic UI labels, single characters, or other garbage.'
        )
      ),
      locationsReason: v.pipe(
        v.string(),
        v.description(
          'One short sentence (≤ ~200 chars) citing concrete items from the locations array — or noting it was empty.'
        )
      ),
      divisionsArePlausible: v.pipe(
        v.boolean(),
        v.description(
          'true iff the divisions array looks like real department/division/team/job-family filter values (or is empty); false if the array is mostly nav chrome, headings, URLs, generic UI labels, single characters, or other garbage.'
        )
      ),
      divisionsReason: v.pipe(
        v.string(),
        v.description(
          'One short sentence (≤ ~200 chars) citing concrete items from the divisions array — or noting it was empty.'
        )
      ),
    }),
    maxAttempts: MAX_ATTEMPTS,
    models: LLM_LISTING_MODEL,
    metadata: { configKey: 'LLM_LISTING_MODEL' },
    logger: terminal,
    validate: parsed => {
      if (!parsed.locationsReason.trim() || !parsed.divisionsReason.trim()) {
        return {
          valid: false,
          feedback:
            'Both locationsReason and divisionsReason must be non-empty single sentences citing concrete items from each array.',
        };
      }

      return {
        valid: true,
        result: {
          locationsArePlausible: parsed.locationsArePlausible,
          locationsReason: parsed.locationsReason.trim(),
          divisionsArePlausible: parsed.divisionsArePlausible,
          divisionsReason: parsed.divisionsReason.trim(),
        },
      };
    },
  });

  return result;
}
