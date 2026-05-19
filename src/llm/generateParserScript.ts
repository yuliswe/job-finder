import { type BrowserContext, type Page } from 'patchright';
import * as v from 'valibot';

import {
  BROWSER_NAVIGATION_TIMEOUT_MS,
  LLM_CODING_MODEL,
} from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { LlmReasoningEffort } from 'src/llm/plugins/interface.js';
import { GENERATE_PARSER_SCRIPT_SYSTEM_PROMPT } from 'src/prompts/generateParserScript.js';
import { pageEval, withBrowserTab } from 'src/utils/browser.js';
import { cleanHtmlForLlm } from 'src/utils/html.js';
import { COLOURS, terminal } from 'src/utils/terminal';

const MAX_SCRIPT_ATTEMPTS = 50;

class ParserScriptAbort extends Error {
  override name = 'ParserScriptAbort';
}

export type GeneratedParserScript = {
  parserScript: string;
  locations: string[];
  divisions: string[];
};

/**
 * Load `listingUrl`, ask the LLM to emit a parser script defining
 * `listLocations()`, `listDivisions()` and `searchJobs({locations, divisions, keywords})`,
 * and run it inside the page in a feedback loop until it returns a non-empty
 * job list. Returns the validated script + the captured location/division
 * options, or null if all attempts fail.
 */
export async function generateParserScript(args: {
  context: BrowserContext;
  listingUrl: string;
}): Promise<GeneratedParserScript | null> {
  const { context, listingUrl } = args;

  return withBrowserTab(context, async page => {
    let snapshot: { title: string; html: string };
    try {
      snapshot = await loadPageSnapshot(page, listingUrl);
    } catch (err) {
      terminal.warn(`Failed to load ${listingUrl}: ${String(err)}`);
      return null;
    }

    terminal.log(
      `Sending the page content to the LLM to generate a parser script. Page title: ${snapshot.title} | Page HTML length: ${snapshot.html.length}`
    );

    try {
      const { result } = await feedbackLoop({
        memory: new Memory([{ system: GENERATE_PARSER_SCRIPT_SYSTEM_PROMPT }]),
        initialPrompt: `
Target listing page URL: ${listingUrl}
Page title: ${snapshot.title}

Page HTML:
${snapshot.html}

Generate the parser script with listLocations(), listDivisions(), and searchJobs({ locations, divisions, keywords }).
`,
        schema: v.object({
          state: v.pipe(
            v.union([
              v.literal('validate'),
              v.literal('still_exploring'),
              v.literal('abort'),
            ]),
            v.description(
              "Set to 'still_exploring' to have your script executed only for its console.log output (returned as feedback). Set to 'validate' when listLocations / listDivisions / searchJobs are ready for the full probe. Set to 'abort' ONLY if you have concluded the task cannot be completed — either the current URL is not actually a job listing page (e.g. it's a marketing page, a single job-detail page, a sign-in wall, or contains no enumerable list of postings) OR the task is logically impossible (e.g. content is behind authentication we don't have, an anti-bot block, a captcha, a deprecated/empty page, or the listing requires interactions Playwright can't perform from a parser script). Use the `reason` field to explain specifically why."
            )
          ),
          parserScript: v.pipe(
            v.string(),
            v.description(
              "Browser-side JavaScript source. When state='validate' it must define top-level listLocations(), listDivisions(), and async searchJobs({locations,divisions,keywords}). If hasLocationFilter is true, listLocations() must return a non-empty array of every selectable location option; same for hasDivisionFilter and listDivisions(). When state='still_exploring' any code is allowed; only console output matters. Ignored when state='abort'."
            )
          ),
          hasLocationFilter: v.pipe(
            v.boolean(),
            v.description(
              "True if the listing page exposes a location / city / region / country filter the user can use to narrow postings. When true, listLocations() MUST return a non-empty array of every selectable option (e.g. ['Toronto', 'New York', 'Remote'])."
            )
          ),
          hasDivisionFilter: v.pipe(
            v.boolean(),
            v.description(
              "True if the listing page exposes a department / division / team / job-family filter the user can use to narrow postings. When true, listDivisions() MUST return a non-empty array of every selectable option (e.g. ['Engineering', 'Sales', 'Design'])."
            )
          ),
          currentAction: v.pipe(
            v.string(),
            v.description(
              'One sentence stating what you are doing in this step, for debugging purposes. Start with "I\'m..."'
            )
          ),
          reason: v.pipe(
            v.string(),
            v.description(
              "One-line summary of the strategy or, when still_exploring, what you are trying to discover. When state='abort', explain specifically why the task cannot be completed — either why the current URL does not contain a job list, or what makes the task logically impossible (auth wall, captcha, anti-bot block, empty page, etc.)."
            )
          ),
        }),
        maxAttempts: MAX_SCRIPT_ATTEMPTS,
        model: LLM_CODING_MODEL,
        metadata: { configKey: 'LLM_CODING_MODEL' },
        logger: terminal,
        reasoningEffort: LlmReasoningEffort.High,
        validate: async parsed => {
          terminal.log(
            `LLM (${parsed.state}): ${parsed.currentAction}\nReason: ${parsed.reason}\nScript size: ${parsed.parserScript.length}`,
            COLOURS.cyan
          );

          if (parsed.state === 'abort') {
            throw new ParserScriptAbort(parsed.reason);
          }

          if (parsed.state === 'still_exploring') {
            const explore = await exploreScript({
              page,
              script: parsed.parserScript,
            });

            terminal.log(
              `Exploration pass: ${explore.logs.length} console log line(s) captured`
            );
            return {
              valid: false,
              feedback:
                "state='still_exploring' — your script was executed once against the current DOM (no reload, top-level code only). Captured console output is below. Revise your script based on the feedback and provide a reason for the changes; when ready to validate the full surface, return state='validate'." +
                formatLogs(explore.logs) +
                (explore.error
                  ? `\n\nNote: top-level execution threw: ${explore.error}`
                  : ''),
            };
          }

          const probe = await validateScript({
            page,
            listingUrl,
            script: parsed.parserScript,
          });

          if (probe.ok) {
            if (parsed.hasLocationFilter && probe.locations.length === 0) {
              return {
                valid: false,
                feedback:
                  'You set hasLocationFilter=true, but listLocations() returned an empty array. Either implement listLocations() so it enumerates every selectable location option visible in the page filter, or set hasLocationFilter=false if no such filter actually exists.',
              };
            }

            if (parsed.hasDivisionFilter && probe.divisions.length === 0) {
              return {
                valid: false,
                feedback:
                  'You set hasDivisionFilter=true, but listDivisions() returned an empty array. Either implement listDivisions() so it enumerates every selectable department/division option visible in the page filter, or set hasDivisionFilter=false if no such filter actually exists.',
              };
            }

            terminal.log(
              `Script validated: ${probe.jobs.length} jobs returned (probe shape: ${JSON.stringify(probe.probed)}; ${probe.logs.length} console log line(s) captured)`,
              COLOURS.green
            );
            return {
              valid: true,
              result: {
                parserScript: parsed.parserScript,
                locations: probe.locations,
                divisions: probe.divisions,
              },
            };
          }

          return { valid: false, feedback: probe.feedback };
        },
      });

      return result;
    } catch (error) {
      if (error instanceof ParserScriptAbort) {
        terminal.warn(
          `LLM aborted parser generation for ${listingUrl}: ${error.message}`
        );
        return null;
      }

      terminal.error(`Error generating parser script: ${String(error)}`);

      return null;
    }
  });
}

async function loadPageSnapshot(
  page: import('patchright').Page,
  url: string
): Promise<{ title: string; html: string }> {
  try {
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
    });
  } catch {
    terminal.warn(
      `Timeout/network error loading ${url}; proceeding with whatever content loaded`
    );
  }

  const title = await page.title();
  const html = await cleanHtmlForLlm(page);
  return { title, html };
}

type ProbeShape = { locations: string[]; divisions: string[] };

type ProbeResult =
  | {
      ok: true;
      jobs: { jobTitle: string; url: string }[];
      probed: ProbeShape;
      locations: string[];
      divisions: string[];
      logs: string[];
    }
  | { ok: false; feedback: string };

async function validateScript(args: {
  page: Page;
  listingUrl: string;
  script: string;
}): Promise<ProbeResult> {
  const { page: parentPage, listingUrl, script } = args;

  // Validate in a fresh tab so prior probes can't leak DOM mutations, cookies
  // set during exploration, modified history/storage, or attached listeners
  // into the next attempt. Open via context.newPage() directly — we
  // deliberately bypass withBrowserTab's semaphore here because the parent tab
  // is already holding a slot and we'd otherwise deadlock when
  // MAX_CONCURRENT_BROWSER_TABS is small.
  const page = await parentPage.context().newPage();
  try {
    try {
      await page.goto(listingUrl, {
        waitUntil: 'networkidle',
        timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
      });
    } catch {
      // proceed with partial content
    }

    return await runProbes(page, script);
  } finally {
    await page.close();
  }
}

async function runProbes(page: Page, script: string): Promise<ProbeResult> {
  // Stage 1: listLocations()
  const locationsProbe = await probeListFn(page, script, 'listLocations');
  if (!locationsProbe.ok) return locationsProbe;
  const { values: locations } = locationsProbe;

  // Stage 2: listDivisions()
  const divisionsProbe = await probeListFn(page, script, 'listDivisions');
  if (!divisionsProbe.ok) return divisionsProbe;
  const { values: divisions } = divisionsProbe;

  // Stage 3: searchJobs(locations, divisions, keywords) — try a few argument shapes
  const probeShapes: ProbeShape[] = [];
  if (locations.length > 0 || divisions.length > 0) {
    probeShapes.push({
      locations: locations[0] ? [locations[0]] : [],
      divisions: divisions[0] ? [divisions[0]] : [],
    });
  }

  probeShapes.push({ locations: [], divisions: [] });

  let lastLogs: string[] = [];

  for (const shape of probeShapes) {
    const argsForLog = JSON.stringify({
      locations: shape.locations,
      divisions: shape.divisions,
      keywords: [],
    });

    const run = await pageEval(
      page,
      async ({
        s,
        a,
      }: {
        s: string;
        a: { locations: string[]; divisions: string[]; keywords: string[] };
      }) => {
        return await runWithConsoleCapture(async () => {
          const fn = new Function('args', `${s}\nreturn searchJobs(args);`);
          return await fn(a);
        });

        function runWithConsoleCapture<R>(
          body: () => Promise<R>
        ): Promise<
          | { ok: true; value: R; logs: string[] }
          | { ok: false; error: string; logs: string[] }
        > {
          const logs: string[] = [];
          const fmt = (v: unknown): string => {
            if (typeof v === 'string') return v;
            try {
              return JSON.stringify(v);
            } catch {
              return String(v);
            }
          };

          const wrap =
            (level: string) =>
            (...xs: unknown[]) => {
              logs.push(`${level}: ${xs.map(fmt).join(' ')}`.slice(0, 1000));
            };

          const orig = {
            log: console.log,
            warn: console.warn,
            error: console.error,
            info: console.info,
          };

          console.log = wrap('log');
          console.warn = wrap('warn');
          console.error = wrap('error');
          console.info = wrap('info');
          return body()
            .then(value => ({ ok: true as const, value, logs }))
            .catch(err => ({
              ok: false as const,
              error: String((err && (err.stack || err.message)) || err).slice(
                0,
                2000
              ),
              logs,
            }))
            .finally(() => {
              console.log = orig.log;
              console.warn = orig.warn;
              console.error = orig.error;
              console.info = orig.info;
            });
        }
      },
      {
        s: script,
        a: {
          locations: shape.locations,
          divisions: shape.divisions,
          keywords: [],
        },
      }
    );

    lastLogs = run.logs;

    if (!run.ok) {
      return {
        ok: false,
        feedback:
          `searchJobs(${argsForLog}) threw an error: ${run.error}. ` +
          'Inspect the DOM and fix the selectors / event handling.' +
          formatLogs(run.logs),
      };
    }

    const jobs = run.value;
    if (!Array.isArray(jobs)) {
      return {
        ok: false,
        feedback:
          `searchJobs(${argsForLog}) must return an array of { jobTitle, url } objects; got: ${JSON.stringify(jobs).slice(0, 200)}` +
          formatLogs(run.logs),
      };
    }

    if (jobs.length === 0) continue;

    for (const j of jobs) {
      if (!j || typeof j !== 'object') {
        return {
          ok: false,
          feedback:
            `searchJobs returned non-object item: ${JSON.stringify(j)}. Each item must be { jobTitle: string, url: string }.` +
            formatLogs(run.logs),
        };
      }

      const obj = j as Record<string, unknown>;
      if (typeof obj.jobTitle !== 'string' || typeof obj.url !== 'string') {
        return {
          ok: false,
          feedback:
            `searchJobs item missing required keys jobTitle/url (got: ${JSON.stringify(obj).slice(0, 200)}). Both must be strings; "url" must be absolute.` +
            formatLogs(run.logs),
        };
      }
    }

    return {
      ok: true,
      jobs: jobs as { jobTitle: string; url: string }[],
      probed: shape,
      locations,
      divisions,
      logs: run.logs,
    };
  }

  return {
    ok: false,
    feedback:
      `searchJobs returned an empty array for every probed input (tried ${JSON.stringify(probeShapes)}). Available locations: ${JSON.stringify(locations)}. Available divisions: ${JSON.stringify(divisions)}. Either widen the result selectors, fix how filters are applied, or wait longer for results to render.` +
      formatLogs(lastLogs),
  };
}

/**
 * Run `script` once on a fresh reload of `listingUrl`, top-level only (no
 * function probing). Capture console output. Used by `state='still_exploring'`.
 */
async function exploreScript(args: {
  page: import('patchright').Page;
  script: string;
}): Promise<{ logs: string[]; error: string | null }> {
  const { page, script } = args;

  try {
    return await pageEval(
      page,
      async ({ s }: { s: string }) => {
        const logs: string[] = [];
        const fmt = (v: unknown): string => {
          if (typeof v === 'string') return v;
          try {
            return JSON.stringify(v);
          } catch {
            return String(v);
          }
        };

        const wrap =
          (level: string) =>
          (...xs: unknown[]) => {
            logs.push(`${level}: ${xs.map(fmt).join(' ')}`.slice(0, 1000));
          };

        const orig = {
          log: console.log,
          warn: console.warn,
          error: console.error,
          info: console.info,
        };

        console.log = wrap('log');
        console.warn = wrap('warn');
        console.error = wrap('error');
        console.info = wrap('info');
        try {
          const fn = new Function(`return (async () => { ${s} })();`);
          await fn();
          return { logs, error: null as string | null };
        } catch (err) {
          const e = err as { stack?: string; message?: string } | undefined;
          return {
            logs,
            error: String(e?.stack ?? e?.message ?? err).slice(0, 2000),
          };
        } finally {
          console.log = orig.log;
          console.warn = orig.warn;
          console.error = orig.error;
          console.info = orig.info;
        }
      },
      { s: script }
    );
  } catch (err) {
    // page.evaluate itself failed (e.g. before our try/catch could run, such as
    // a transpiler-helper reference in the evaluate wrapper). Surface it to the
    // LLM as feedback rather than crashing the loop.
    return {
      logs: [],
      error: `page.evaluate failed: ${String(err).slice(0, 2000)}`,
    };
  }
}

function formatLogs(logs: string[]): string {
  if (logs.length === 0) {
    return "\n\n(No console output captured. You can add console.log/info/warn/error to the script to inspect the DOM, see the next attempt's feedback.)";
  }

  const MAX = 50;
  const shown = logs.slice(0, MAX);
  const more =
    logs.length > MAX ? `\n… and ${logs.length - MAX} more line(s)` : '';

  return `\n\nCaptured console output from your script (${logs.length} line(s)):\n${shown.join('\n')}${more}`;
}

type ListFnProbe =
  | { ok: true; values: string[] }
  | { ok: false; feedback: string };

async function probeListFn(
  page: import('patchright').Page,
  script: string,
  fnName: 'listLocations' | 'listDivisions'
): Promise<ListFnProbe> {
  const run = await pageEval(
    page,
    ({ s, name }: { s: string; name: string }) => {
      const logs: string[] = [];
      const fmt = (v: unknown): string => {
        if (typeof v === 'string') return v;
        try {
          return JSON.stringify(v);
        } catch {
          return String(v);
        }
      };

      const wrap =
        (level: string) =>
        (...xs: unknown[]) => {
          logs.push(`${level}: ${xs.map(fmt).join(' ')}`.slice(0, 1000));
        };

      const orig = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
      };

      console.log = wrap('log');
      console.warn = wrap('warn');
      console.error = wrap('error');
      console.info = wrap('info');
      try {
        const fn = new Function(
          `${s}\nreturn typeof ${name} === 'function' ? ${name}() : null;`
        );

        const value = fn();
        return { ok: true as const, value, logs };
      } catch (err) {
        const e = err as { stack?: string; message?: string } | undefined;
        return {
          ok: false as const,
          error: String(e?.stack ?? e?.message ?? err).slice(0, 2000),
          logs,
        };
      } finally {
        console.log = orig.log;
        console.warn = orig.warn;
        console.error = orig.error;
        console.info = orig.info;
      }
    },
    { s: script, name: fnName }
  );

  if (!run.ok) {
    return {
      ok: false,
      feedback:
        `${fnName}() threw an error: ${run.error}. Fix the function definition or the DOM queries inside it.` +
        formatLogs(run.logs),
    };
  }

  if (run.value === null) {
    return {
      ok: false,
      feedback:
        `Your script did not define a top-level function called ${fnName}. Define it at the top scope (not inside another function).` +
        formatLogs(run.logs),
    };
  }

  if (!Array.isArray(run.value)) {
    return {
      ok: false,
      feedback:
        `${fnName}() must return an array of strings; got: ${JSON.stringify(run.value).slice(0, 200)}` +
        formatLogs(run.logs),
    };
  }

  return { ok: true, values: run.value.map(String) };
}
