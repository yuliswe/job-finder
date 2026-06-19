import { type BrowserContext, type Page } from 'patchright';
import * as v from 'valibot';

import { LLM_CODING_MODEL } from 'jobfinder.config.js';
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
      availableLocations = await callListFn(page, script, 'listLocations');
      availableDivisions = await callListFn(page, script, 'listDivisions');

      terminal.log(
        `This company hires from ${availableLocations.length} locations and ${availableDivisions.length} divisions`
      );
    } catch (err) {
      return {
        ok: false,
        reason: 'script_error',
        error: `listLocations/listDivisions threw: ${String(err).slice(0, 500)}`,
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

async function callListFn(
  page: Page,
  script: string,
  fnName: 'listLocations' | 'listDivisions'
): Promise<string[]> {
  const value = await pageEval(
    page,
    async ({ s, name }: { s: string; name: string }) => {
      const fn = new Function(
        `${s}\nreturn typeof ${name} === 'function' ? ${name}() : null;`
      );

      return await fn();
    },
    { s: script, name: fnName },
    { timeoutMs: 60_000 }
  );

  if (!Array.isArray(value)) {
    throw new Error(
      `${fnName}() did not return an array (got ${typeof value})`
    );
  }

  return value.filter((x): x is string => typeof x === 'string');
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
      pickedLocations: v.pipe(
        v.array(v.string()),
        v.description(
          'Subset of the available locations that best match the user-supplied location string. Must be entries copied verbatim from the available list. Empty if the available list is empty, the user string is blank, or no option is a plausible match.'
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
      const badLoc = parsed.pickedLocations.filter(l => !locSet.has(l));
      const badDiv = parsed.pickedDivisions.filter(d => !divSet.has(d));
      if (badLoc.length > 0 || badDiv.length > 0) {
        return {
          valid: false,
          feedback: `Invalid picks (must be copied verbatim from the available lists). Invented locations: ${JSON.stringify(badLoc)}. Invented divisions: ${JSON.stringify(badDiv)}.`,
        };
      }

      terminal.llmResponse(
        `LLM (${ctx.model}): I've picked location(s): ${parsed.pickedLocations.join(', ') || '(none)'} | division(s): ${parsed.pickedDivisions.join(', ') || '(none)'}\nExplanation: ${parsed.reason}`
      );

      // Reload before each attempt so the script's prior DOM mutations,
      // scroll position, or backend pagination state can't leak into the
      // next call — repeated searchJobs() on the same page is not idempotent
      // for many real-world listing implementations (Workday, etc.).
      await goToPage(page, page.url());
      const jobs = await callSearchJobs(page, script, {
        locations: parsed.pickedLocations,
        divisions: parsed.pickedDivisions,
        keywords: [],
      });

      if (jobs.length > 100) {
        return {
          valid: false,
          feedback:
            'Too many jobs returned (more than 100). Please refine your filters.',
        };
      }

      return {
        valid: true,
        result: {
          jobs,
          picked: {
            locations: parsed.pickedLocations,
            divisions: parsed.pickedDivisions,
          },
        },
      };
    },
  });

  return result;
}
