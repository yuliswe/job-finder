import { type BrowserContext, type Page } from 'patchright';
import * as v from 'valibot';

import {
  LLM_CODING_MODEL,
  PIPELINE_RUN_SCRIPTS_SPAM_PREVENTION_JOB_COUNTS,
} from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { PICK_FILTER_OPTIONS_SYSTEM_PROMPT } from 'src/prompts/pickFilterOptions.js';
import { goToPage, pageEval, withBrowserTab } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal';

const MAX_PICK_ATTEMPTS = 3;

export type RunParserScriptResult =
  | {
      ok: true;
      jobs: { jobTitle: string; url: string }[];
      picked: { locations: string[]; divisions: string[] };
    }
  | { ok: false; reason: 'script_error'; error: string }
  | {
      ok: false;
      reason: 'no_result_found';
      picked: { locations: string[]; divisions: string[] };
    };

/**
 * Open `listingUrl`, run the previously-generated `script`, let the LLM map
 * the user-supplied `division`/`location` strings to actual filter values
 * exposed by `listDivisions()` / `listLocations()`, then invoke `searchJobs`
 * with the picks and return the jobs it produces.
 */
export async function runParserScript(args: {
  context: BrowserContext;
  listingUrl: string;
  script: string;
  userLocation: string;
  userDivision: string;
}): Promise<RunParserScriptResult> {
  const { context, listingUrl, script, userLocation, userDivision } = args;

  return withBrowserTab(context, async page => {
    await goToPage(page, listingUrl);

    let availableLocations: string[];
    let availableDivisions: string[];
    try {
      const { locations, divisions } = await callDiscover(page, script);
      availableLocations = locations;
      availableDivisions = divisions;

      terminal.log(
        `This company hires from ${availableLocations.length} locations and ${availableDivisions.length} divisions`
      );
    } catch (err) {
      return {
        ok: false,
        reason: 'script_error',
        error: `discover() threw: ${String(err).slice(0, 500)}`,
      };
    }

    const { jobs, picked } = await pickFilterOptions({
      page,
      script,
      userLocation,
      userDivision,
      availableLocations,
      availableDivisions,
    });

    if (jobs.length === 0) {
      terminal.log('No jobs found.');

      return { ok: false, reason: 'no_result_found', picked };
    }

    terminal.log(
      `Found ${jobs.length} jobs:\n${jobs.map(j => `- ${j.jobTitle}: ${j.url}`).join('\n')}`
    );
    return { ok: true, jobs, picked };
  });
}

async function callDiscover(
  page: Page,
  script: string
): Promise<{ locations: string[]; divisions: string[] }> {
  const value = await pageEval(
    page,
    async ({ s }: { s: string }) => {
      const fn = new Function(
        `${s}\nreturn typeof discover === 'function' ? discover() : null;`
      );

      return await fn();
    },
    { s: script },
    { timeoutMs: 60_000 }
  );

  if (value === null) {
    throw new Error(
      'Script does not define a top-level `discover` function. (The stored parserScript was generated against an older contract — regenerate via `jobfinder pipeline scripting --job-list-source-id <id>`.)'
    );
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `discover() did not return an object (got ${value === null ? 'null' : typeof value})`
    );
  }

  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.locations) || !Array.isArray(v.divisions)) {
    throw new Error(
      `discover() must return { locations: string[], divisions: string[], ... }; got: ${JSON.stringify(v).slice(0, 200)}`
    );
  }

  return {
    locations: v.locations.filter((x): x is string => typeof x === 'string'),
    divisions: v.divisions.filter((x): x is string => typeof x === 'string'),
  };
}

async function callSearchJobs(
  page: Page,
  script: string,
  args: { locations: string[]; divisions: string[]; keywords: string[] }
): Promise<{ jobTitle: string; url: string }[]> {
  const value = await pageEval(
    page,
    async ({
      s,
      a,
    }: {
      s: string;
      a: { locations: string[]; divisions: string[]; keywords: string[] };
    }) => {
      const fn = new Function('args', `${s}\nreturn searchJobs(args);`);
      return await fn(a);
    },
    { s: script, a: args },
    { timeoutMs: 60_000 }
  );

  if (!Array.isArray(value)) {
    throw new Error('searchJobs() did not return an array');
  }

  const out: { jobTitle: string; url: string }[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as { jobTitle?: unknown }).jobTitle === 'string' &&
      typeof (item as { url?: unknown }).url === 'string'
    ) {
      out.push({
        jobTitle: (item as { jobTitle: string }).jobTitle,
        url: (item as { url: string }).url,
      });
    }
  }

  return out;
}

async function pickFilterOptions(args: {
  page: Page;
  script: string;
  userLocation: string;
  userDivision: string;
  availableLocations: string[];
  availableDivisions: string[];
}): Promise<{
  jobs: { jobTitle: string; url: string }[];
  picked: { locations: string[]; divisions: string[] };
}> {
  const {
    page,
    script,
    userLocation,
    userDivision,
    availableLocations,
    availableDivisions,
  } = args;

  const locSet = new Set(availableLocations);
  const divSet = new Set(availableDivisions);

  const memory = new Memory([{ system: PICK_FILTER_OPTIONS_SYSTEM_PROMPT }]);

  terminal.llmRequest(
    "Asking LLM to pick best-matching location/division from the page's available filters..."
  );

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `User-supplied location: ${userLocation || '(blank)'}
User-supplied division: ${userDivision || '(blank)'}

Available locations (${availableLocations.length}):
${availableLocations.map(s => `- ${s}`).join('\n') || '(none — the page has no location filter)'}

Available divisions (${availableDivisions.length}):
${availableDivisions.map(s => `- ${s}`).join('\n') || '(none — the page has no division filter)'}

Pick the best-matching options for each axis.`,
    schema: v.object({
      locationTiers: v.pipe(
        v.array(v.array(v.string())),
        v.description(
          'Tiered location candidates, ordered narrowest-to-broadest. Each tier is one search attempt — the runner walks EVERY tier and accumulates the union of results (deduped by URL), stopping only when the spam cap is reached. Tiers are additive scopes, not fallbacks. Entries must be copied verbatim from the available list. Use [] (an empty outer array) when the user string is blank, the page has no location filter, or no option is a plausible match.'
        )
      ),
      pickedDivisions: v.pipe(
        v.array(v.string()),
        v.description(
          'Subset of the available divisions that best match the user-supplied division string. Must be entries copied verbatim from the available list. Empty if the available list is empty, the user string is blank, or no option is a plausible match.'
        )
      ),
      reason: v.pipe(
        v.string(),
        v.description('One-line explanation of how you mapped the user input.')
      ),
    }),
    maxAttempts: MAX_PICK_ATTEMPTS,
    models: LLM_CODING_MODEL,
    metadata: { configKey: 'LLM_CODING_MODEL' },
    logger: terminal,
    validate: async (parsed, ctx) => {
      const badLoc = parsed.locationTiers.flat().filter(l => !locSet.has(l));

      const badDiv = parsed.pickedDivisions.filter(d => !divSet.has(d));
      if (badLoc.length > 0 || badDiv.length > 0) {
        return {
          valid: false,
          feedback: `Invalid picks (must be copied verbatim from the available lists). Invented locations: ${JSON.stringify(badLoc)}. Invented divisions: ${JSON.stringify(badDiv)}.`,
        };
      }

      // Always run at least one search — even if the LLM returned no tiers
      // (e.g. blank user location, or the page has no location filter), we
      // still want to try once with no locations applied.
      const tiers =
        parsed.locationTiers.length > 0 ? parsed.locationTiers : [[]];

      const tierSummary = tiers
        .map(t => (t.length === 0 ? '(no filter)' : t.join(', ')))
        .join(' → ');

      terminal.llmResponse(
        `LLM (${ctx.model}): location tiers: ${tierSummary} | division(s): ${parsed.pickedDivisions.join(', ') || '(none)'}\nExplanation: ${parsed.reason}`
      );

      const spamCap = PIPELINE_RUN_SCRIPTS_SPAM_PREVENTION_JOB_COUNTS;
      const accumulated = new Map<string, { jobTitle: string; url: string }>();
      const contributingTiers: string[][] = [];

      for (let i = 0; i < tiers.length; i++) {
        const tier = tiers[i];
        const label = tier.length === 0 ? '(no filter)' : tier.join(', ');

        terminal.log(`Trying location tier ${i + 1}/${tiers.length}: ${label}`);

        // Reload before each attempt so the script's prior DOM mutations,
        // scroll position, or backend pagination state can't leak into the
        // next call — repeated searchJobs() on the same page is not
        // idempotent for many real-world listing implementations (Workday,
        // etc.).
        await goToPage(page, page.url());
        const jobs = await callSearchJobs(page, script, {
          locations: tier,
          divisions: parsed.pickedDivisions,
          keywords: [],
        });

        // Catch malformed tiers up front: if the narrowest tier alone is
        // already pouring out 2× the spam cap, the LLM's tiering was off
        // (e.g. tier 0 included an entire country). Ask it to refine.
        if (i === 0 && jobs.length > spamCap * 2) {
          return {
            valid: false,
            feedback: `Tier 1 (${label}) returned ${jobs.length} jobs — too broad for the narrowest tier. Use a more specific city / metro at tier 0 and push the country / region picks to later tiers.`,
          };
        }

        const before = accumulated.size;
        for (const j of jobs) {
          if (!accumulated.has(j.url)) accumulated.set(j.url, j);
        }

        const added = accumulated.size - before;
        if (added > 0) contributingTiers.push(tier);

        const existing = jobs.length - added;

        terminal.log(
          `  ${jobs.length} returned (+${added} new, ${existing} already seen) — ${accumulated.size} total across tiers`
        );

        if (accumulated.size >= spamCap) {
          terminal.log(
            `Reached spam cap (${spamCap}) after tier ${i + 1}; stopping.`
          );
          break;
        }
      }

      // `picked.locations` is the union of every tier that actually
      // contributed jobs, so downstream logs reflect what was effectively
      // applied. Surface empty result to the caller as-is — run-pipeline
      // records `no_result_found` when there are zero jobs across every
      // tier the LLM thought worth trying.
      return {
        valid: true,
        result: {
          jobs: Array.from(accumulated.values()),
          picked: {
            locations: Array.from(new Set(contributingTiers.flat())),
            divisions: parsed.pickedDivisions,
          },
        },
      };
    },
  });

  return result;
}
