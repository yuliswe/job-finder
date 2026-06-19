import { type BrowserContext, type Page } from 'patchright';
import * as v from 'valibot';

import { feedbackLoop, Memory } from 'src/llm/base.js';
import { LlmReasoningEffort } from 'src/llm/plugins/interface.js';
import { verifyFilterValues } from 'src/llm/verifyFilterValues.js';
import { GENERATE_PARSER_SCRIPT_SYSTEM_PROMPT } from 'src/prompts/generateParserScript.js';
import {
  goToPage,
  pageEval,
  PageEvalTimeoutError,
  withBrowserTab,
} from 'src/utils/browser.js';
import { cleanHtmlForLlm } from 'src/utils/html.js';
import { COLOURS, terminal } from 'src/utils/terminal';

const MAX_SCRIPT_ATTEMPTS = 5;

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
 *
 * `models` is the LLM fallback chain (e.g. `LLM_CODING_MODEL`) —
 * cheaper-to-smarter ordering; `sendWithRetry` advances automatically
 * when a model exhausts its attempt budget.
 */
export async function generateParserScript(args: {
  context: BrowserContext;
  listingUrl: string;
  models: string[];
}): Promise<GeneratedParserScript | null> {
  const { context, listingUrl, models } = args;

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
            // Use picklist rather than union-of-literals so the JSON schema
            // serializes as `{type:'string', enum:[...]}` instead of
            // `{anyOf:[{const:...},...]}`. OpenAI's strict mode rejects the
            // anyOf-without-type form with `invalid_json_schema`.
            v.picklist(['validate', 'still_exploring', 'abort']),
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
          hasLocationFilterReason: v.pipe(
            v.string(),
            v.description(
              'One short sentence (≤ ~140 chars) citing the concrete DOM evidence behind hasLocationFilter — e.g. "<select id=location> with 12 options" or "no location dropdown found in filter sidebar".'
            )
          ),
          hasDivisionFilter: v.pipe(
            v.boolean(),
            v.description(
              "True if the listing page exposes a department / division / team / job-family filter the user can use to narrow postings. When true, listDivisions() MUST return a non-empty array of every selectable option (e.g. ['Engineering', 'Sales', 'Design'])."
            )
          ),
          hasDivisionFilterReason: v.pipe(
            v.string(),
            v.description(
              'One short sentence (≤ ~140 chars) citing the concrete DOM evidence behind hasDivisionFilter — e.g. "<select id=department> with 8 options" or "filter bar has only search + sort, no department".'
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
        models,
        metadata: { configKey: 'LLM_CODING_MODEL' },
        logger: terminal,
        reasoningEffort: LlmReasoningEffort.High,
        validate: async (parsed, ctx) => {
          terminal.log(
            `LLM (${ctx.model}): state=${parsed.state} | ${parsed.currentAction}\nReason: ${parsed.reason}\nScript size: ${parsed.parserScript.length}`,
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
              `LLM (${ctx.model}): Exploration pass: ${explore.logs.length} console log line(s) captured`
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

          terminal.log(
            `LLM (${ctx.model}): Filters — hasLocationFilter=${parsed.hasLocationFilter} (${parsed.hasLocationFilterReason}); hasDivisionFilter=${parsed.hasDivisionFilter} (${parsed.hasDivisionFilterReason})`,
            COLOURS.cyan
          );

          const probe = await validateScriptBestOf3({
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
              `LLM (${ctx.model}): Script validated: ${probe.jobs.length} jobs returned (probe shape: ${JSON.stringify(probe.probed)}; ${probe.logs.length} console log line(s) captured)`,
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
  await goToPage(page, url);

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

/** Validation is flaky (network jitter, slow hydration, transient
 * anti-bot challenges). Run the probe up to 3 times sequentially and pass
 * as soon as we've seen 2 successes. Fail as soon as 2 attempts have failed
 * (early-exit — no point running a 3rd attempt). Returns the first
 * successful result on pass, or the first failure on fail. */
async function validateScriptBestOf3(args: {
  page: Page;
  listingUrl: string;
  script: string;
}): Promise<ProbeResult> {
  const ATTEMPTS = 3;
  const NEEDED = 2;

  let successes = 0;
  let failures = 0;
  let firstSuccess: ProbeResult | null = null;
  let firstFailure: ProbeResult | null = null;

  for (let i = 1; i <= ATTEMPTS; i++) {
    const result = await validateScript(args);
    if (result.ok) {
      successes++;
      if (!firstSuccess) firstSuccess = result;

      terminal.log(
        `Validation attempt ${i}/${ATTEMPTS}: PASS (${successes}/${NEEDED} passes so far)`,
        COLOURS.green
      );
      if (successes >= NEEDED) return firstSuccess;
    } else {
      failures++;
      if (!firstFailure) firstFailure = result;

      terminal.log(
        `Validation attempt ${i}/${ATTEMPTS}: FAIL (${failures}/${NEEDED} failures so far)`,
        COLOURS.yellow
      );
      if (failures >= NEEDED) return firstFailure;
    }
  }

  // Unreachable: with 3 attempts and NEEDED=2, we always hit one of the
  // early returns above. Guard anyway for type narrowing.
  return firstSuccess ?? firstFailure!;
}

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
    await goToPage(page, listingUrl);

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

  // Stage 2.5: LLM sanity check on the extracted values. A buggy selector
  // can grab nav chrome, headings, or generic UI labels instead of real
  // filter options; surface that as feedback so the script LLM fixes the
  // selector before we run the more expensive Stage-3 search probes.
  if (locations.length > 0 || divisions.length > 0) {
    const verdict = await verifyFilterValues({ locations, divisions });

    if (!verdict.locationsArePlausible || !verdict.divisionsArePlausible) {
      const parts: string[] = [];
      if (!verdict.locationsArePlausible) {
        parts.push(
          `listLocations() returned ${locations.length} values that don't look like locations: ${JSON.stringify(locations.slice(0, 10))}. Verifier reason: ${verdict.locationsReason}. Fix the selector to grab the real location filter options, or set hasLocationFilter=false and return [] if no location filter actually exists.`
        );
      }

      if (!verdict.divisionsArePlausible) {
        parts.push(
          `listDivisions() returned ${divisions.length} values that don't look like divisions: ${JSON.stringify(divisions.slice(0, 10))}. Verifier reason: ${verdict.divisionsReason}. Fix the selector to grab the real department/division filter options, or set hasDivisionFilter=false and return [] if no division filter actually exists.`
        );
      }

      return { ok: false, feedback: parts.join('\n\n') };
    }
  }

  // Stage 3a: baseline — searchJobs with empty filters. This is the page's
  // unfiltered listing; we use it as the reference set for filter-effectiveness.
  const baselineShape: ProbeShape = { locations: [], divisions: [] };
  const baseline = await runSearchJobs(page, script, baselineShape);
  if (!baseline.ok) return baseline;

  // Stage 3b: filtered probe — only meaningful if either filter has options.
  // We compare against the baseline to make sure the script's filter logic
  // actually changes the result set rather than ignoring its arguments and
  // returning the page's default listing.
  const canFilter = locations.length > 0 || divisions.length > 0;
  if (canFilter) {
    const filterShape: ProbeShape = {
      locations: locations[0] ? [locations[0]] : [],
      divisions: divisions[0] ? [divisions[0]] : [],
    };

    const filtered = await runSearchJobs(page, script, filterShape);
    if (!filtered.ok) return filtered;

    if (sameJobSet(baseline.jobs, filtered.jobs)) {
      return {
        ok: false,
        feedback:
          `searchJobs returned the same ${baseline.jobs.length} jobs for empty filters ${JSON.stringify({ ...baselineShape, keywords: [] })} AND for ${JSON.stringify({ ...filterShape, keywords: [] })}. ` +
          "Your filter logic is a no-op — it returns the page's initial listing regardless of the locations/divisions arguments. " +
          'Drive the actual filter UI (click the option, await the DOM update, then read the filtered results), or call the underlying search/XHR endpoint with the filter applied.' +
          formatLogs(filtered.logs),
      };
    }

    if (filtered.jobs.length > 0) {
      return {
        ok: true,
        jobs: filtered.jobs,
        probed: filterShape,
        locations,
        divisions,
        logs: filtered.logs,
      };
    }
    // Filtered probe came back empty but differs from baseline — fall through
    // to the baseline result so we still surface a usable job list.
  }

  if (baseline.jobs.length === 0) {
    return {
      ok: false,
      feedback:
        `searchJobs(${JSON.stringify({ ...baselineShape, keywords: [] })}) returned an empty array. Available locations: ${JSON.stringify(locations)}. Available divisions: ${JSON.stringify(divisions)}. Either widen the result selectors or wait longer for results to render.` +
        formatLogs(baseline.logs),
    };
  }

  return {
    ok: true,
    jobs: baseline.jobs,
    probed: baselineShape,
    locations,
    divisions,
    logs: baseline.logs,
  };
}

type SearchJobsResult =
  | {
      ok: true;
      jobs: { jobTitle: string; url: string }[];
      logs: string[];
    }
  | { ok: false; feedback: string };

async function runSearchJobs(
  page: Page,
  script: string,
  shape: ProbeShape
): Promise<SearchJobsResult> {
  const argsForLog = JSON.stringify({
    locations: shape.locations,
    divisions: shape.divisions,
    keywords: [],
  });

  let run:
    | { ok: true; value: unknown; logs: string[]; fetches: string[] }
    | { ok: false; error: string; logs: string[]; fetches: string[] };

  try {
    run = await pageEval(
      page,
      async ({
        s,
        a,
      }: {
        s: string;
        a: { locations: string[]; divisions: string[]; keywords: string[] };
      }) => {
        return await runWithCapture(async () => {
          const fn = new Function('args', `${s}\nreturn searchJobs(args);`);
          return await fn(a);
        });

        function runWithCapture<R>(body: () => Promise<R>): Promise<
          | {
              ok: true;
              value: R;
              logs: string[];
              fetches: string[];
            }
          | {
              ok: false;
              error: string;
              logs: string[];
              fetches: string[];
            }
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
              logs.push(`${level}: ${xs.map(fmt).join(' ')}`);
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

          // Capture every outbound `fetch` the script makes — URL, method,
          // request body (truncated), HTTP status, and a preview of the
          // response body. On failure feedback we surface the last few so
          // the LLM can see what request triggered an error like a 400 /
          // 500 (without having to re-discover it via still_exploring).
          const fetches: string[] = [];
          const origFetch = window.fetch;
          const trunc = (s: string, n: number) =>
            s.length > n ? s.slice(0, n) + `…(+${s.length - n}b)` : s;

          window.fetch = async function patchedFetch(
            input: RequestInfo | URL,
            init?: RequestInit
          ): Promise<Response> {
            const url =
              typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.toString()
                  : input.url;

            const method =
              (init && init.method) ||
              (input instanceof Request ? input.method : 'GET');

            const reqBody =
              init && init.body
                ? typeof init.body === 'string'
                  ? init.body
                  : '[non-string body]'
                : '';

            try {
              const res = await origFetch.call(
                this,
                input as RequestInfo,
                init
              );

              let preview = '';
              try {
                preview = await res.clone().text();
              } catch {
                preview = '[unreadable]';
              }

              fetches.push(
                `${method} ${url} → ${res.status}${reqBody ? ` | body: ${trunc(reqBody, 400)}` : ''} | response: ${trunc(preview, 400)}`
              );
              return res;
            } catch (err) {
              fetches.push(
                `${method} ${url} → THREW ${String((err as Error)?.message ?? err)}${reqBody ? ` | body: ${trunc(reqBody, 400)}` : ''}`
              );
              throw err;
            }
          };

          return body()
            .then(value => ({
              ok: true as const,
              value,
              logs,
              fetches,
            }))
            .catch(err => ({
              ok: false as const,
              error: String((err && (err.stack || err.message)) || err),
              logs,
              fetches,
            }))
            .finally(() => {
              console.log = orig.log;
              console.warn = orig.warn;
              console.error = orig.error;
              console.info = orig.info;
              window.fetch = origFetch;
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
      },
      { timeoutMs: 60_000 }
    );
  } catch (err) {
    if (err instanceof PageEvalTimeoutError) {
      return {
        ok: false,
        feedback:
          `searchJobs(${argsForLog}) timed out after ${Math.round(err.timeoutMs / 1000)}s and never returned. ` +
          'Likely causes: an unresolved promise, an infinite wait for a selector / network response, or a runaway loop. ' +
          'Make sure searchJobs returns promptly — bound any waitForSelector / setTimeout, resolve every awaited promise, and return as soon as the listing is captured.',
      };
    }

    throw err;
  }

  if (!run.ok) {
    return {
      ok: false,
      feedback:
        `searchJobs(${argsForLog}) threw an error: ${run.error}. ` +
        'Inspect the DOM and fix the selectors / event handling.' +
        formatLogs(run.logs) +
        formatFetches(run.fetches),
    };
  }

  const jobs = run.value;
  if (!Array.isArray(jobs)) {
    return {
      ok: false,
      feedback:
        `searchJobs(${argsForLog}) must return an array of { jobTitle, url } objects; got: ${JSON.stringify(jobs).slice(0, 200)}` +
        formatLogs(run.logs) +
        formatFetches(run.fetches),
    };
  }

  for (const j of jobs) {
    if (!j || typeof j !== 'object') {
      return {
        ok: false,
        feedback:
          `searchJobs returned non-object item: ${JSON.stringify(j)}. Each item must be { jobTitle: string, url: string }.` +
          formatLogs(run.logs) +
          formatFetches(run.fetches),
      };
    }

    const obj = j as Record<string, unknown>;
    if (typeof obj.jobTitle !== 'string' || typeof obj.url !== 'string') {
      return {
        ok: false,
        feedback:
          `searchJobs item missing required keys jobTitle/url (got: ${JSON.stringify(obj).slice(0, 200)}). Both must be strings; "url" must be absolute.` +
          formatLogs(run.logs) +
          formatFetches(run.fetches),
      };
    }
  }

  return {
    ok: true,
    jobs: jobs as { jobTitle: string; url: string }[],
    logs: run.logs,
  };
}

/** True iff two job lists describe the same set of postings by URL. Used to
 * detect the "filter is a no-op" failure mode: identical URL set across an
 * unfiltered call and a filtered call means searchJobs is ignoring its args. */
function sameJobSet(a: { url: string }[], b: { url: string }[]): boolean {
  if (a.length !== b.length) return false;
  const aSet = new Set(a.map(j => j.url));
  for (const j of b) if (!aSet.has(j.url)) return false;
  return true;
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
            logs.push(`${level}: ${xs.map(fmt).join(' ')}`);
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
            error: String(e?.stack ?? e?.message ?? err),
          };
        } finally {
          console.log = orig.log;
          console.warn = orig.warn;
          console.error = orig.error;
          console.info = orig.info;
        }
      },
      { s: script },
      { timeoutMs: 60_000 }
    );
  } catch (err) {
    // page.evaluate itself failed (e.g. before our try/catch could run, such as
    // a transpiler-helper reference in the evaluate wrapper). Surface it to the
    // LLM as feedback rather than crashing the loop.
    return {
      logs: [],
      error: `page.evaluate failed: ${String(err)}`,
    };
  }
}

function formatLogs(logs: string[]): string {
  if (logs.length === 0) {
    return "\n\n(No console output captured. You can add console.log/info/warn/error to the script to inspect the DOM, see the next attempt's feedback.)";
  }

  return `\n\nCaptured console output from your script (${logs.length} line(s)):\n${logs.join('\n')}`;
}

/** Surface the last few outbound `fetch` calls so the LLM can see what
 * its script actually sent that triggered a failure — e.g., the body of
 * the POST that came back as a 400. The browser-side capture is in the
 * runWithCapture helper inside the page.evaluate IIFE; this just formats
 * the resulting strings for inclusion in the feedback message. */
function formatFetches(fetches: string[]): string {
  if (fetches.length === 0) return '';
  const tail = fetches.slice(-3);
  return `\n\nRecent outbound fetch calls from your script (last ${tail.length} of ${fetches.length}):\n${tail.map((f, i) => `  [${fetches.length - tail.length + i + 1}] ${f}`).join('\n')}`;
}

type ListFnProbe =
  | { ok: true; values: string[] }
  | { ok: false; feedback: string };

async function probeListFn(
  page: import('patchright').Page,
  script: string,
  fnName: 'listLocations' | 'listDivisions'
): Promise<ListFnProbe> {
  let run:
    | { ok: true; value: unknown; logs: string[] }
    | { ok: false; error: string; logs: string[] };

  try {
    run = await pageEval(
      page,
      async ({ s, name }: { s: string; name: string }) => {
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
            logs.push(`${level}: ${xs.map(fmt).join(' ')}`);
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

          const value = await fn();
          return { ok: true as const, value, logs };
        } catch (err) {
          const e = err as { stack?: string; message?: string } | undefined;
          return {
            ok: false as const,
            error: String(e?.stack ?? e?.message ?? err),
            logs,
          };
        } finally {
          console.log = orig.log;
          console.warn = orig.warn;
          console.error = orig.error;
          console.info = orig.info;
        }
      },
      { s: script, name: fnName },
      { timeoutMs: 60_000 }
    );
  } catch (err) {
    if (err instanceof PageEvalTimeoutError) {
      return {
        ok: false,
        feedback:
          `${fnName}() timed out after ${Math.round(err.timeoutMs / 1000)}s and never resolved. ` +
          'Likely causes: an unresolved promise, an infinite wait for a selector, or a runaway loop. ' +
          `Make sure ${fnName}() resolves promptly — bound any waitForSelector / setTimeout and return as soon as the values are collected.`,
      };
    }

    throw err;
  }

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
