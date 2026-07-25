import { type BrowserContext, type Page } from 'patchright';
import * as v from 'valibot';

import { LLM_FILL_FORM_MODEL } from 'src/utils/config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { LlmReasoningEffort } from 'src/llm/plugins/interface.js';
import {
  callFillFormScript,
  rereadFormValues,
  type ScriptCapture,
} from 'src/llm/runFillFormScript.js';
import { GENERATE_FILL_FORM_SCRIPT_SYSTEM_PROMPT } from 'src/prompts/generateFillFormScript.js';
import type { ApplicantProfile } from 'src/utils/applicantProfile.js';
import { goToPage, withBrowserTab } from 'src/utils/browser.js';
import { cleanHtmlForLlm } from 'src/utils/html.js';
import { COLOURS, terminal } from 'src/utils/terminal.js';

const MAX_SCRIPT_ATTEMPTS = 5;

class FillFormAbort extends Error {
  override name = 'FillFormAbort';
}

/** Shape returned by the generated `fillForm(profile)` function. */
export type FillFormReport = {
  filled: { label: string; selector: string; type: string; valueSet: string }[];
  skipped: { label: string; selector: string; reason: string }[];
};

/** One field as reported by the generated `discoverFields()` function. */
export type DiscoveredField = {
  label: string;
  selector: string;
  type: string;
  required?: boolean;
  options?: string[];
  currentValue?: string;
};

/**
 * Open `applicationUrl`, ask the LLM to emit a script defining
 * `discoverFields()` and `fillForm(profile)`, and run it inside the page in a
 * feedback loop until the fill probe actually populates fields. Returns the
 * validated script source, or null if all attempts fail / the LLM aborts.
 */
export async function generateFillFormScript(args: {
  context: BrowserContext;
  applicationUrl: string;
  profile: ApplicantProfile;
  models?: string[];
}): Promise<string | null> {
  const {
    context,
    applicationUrl,
    profile,
    models = LLM_FILL_FORM_MODEL,
  } = args;

  return withBrowserTab(context, async page => {
    let snapshot: { title: string; html: string };
    try {
      snapshot = await loadPageSnapshot(page, applicationUrl);
    } catch (err) {
      terminal.warn(`Failed to load ${applicationUrl}: ${String(err)}`);
      return null;
    }

    terminal.log(
      `[HARNESS] Sending the application form to the LLM. Page title: ${snapshot.title} | HTML length: ${snapshot.html.length}`
    );

    const profileKeys = Object.keys(profile.fields).join(', ') || '(none)';

    try {
      const { result } = await feedbackLoop({
        memory: new Memory([
          { system: GENERATE_FILL_FORM_SCRIPT_SYSTEM_PROMPT },
        ]),
        initialPrompt: `
Application page URL: ${applicationUrl}
Page title: ${snapshot.title}

Applicant profile keys available on profile.fields: ${profileKeys}

Applicant profile (raw, for free-text answers):
${profile.raw}

Page HTML:
${snapshot.html}

Emit the fill-form script with discoverFields() and fillForm(profile). Do not submit the form.
`,
        schema: v.object({
          state: v.pipe(
            v.picklist(['validate', 'still_exploring', 'abort']),
            v.description(
              "Set 'still_exploring' to run the script once for console.log output only. Set 'validate' when discoverFields and fillForm are ready for the full probe. Set 'abort' when the application form cannot be reached or filled (e.g. the page is only a description with an Apply link, an auth wall, or a captcha) — explain in reason."
            )
          ),
          fillFormScript: v.pipe(
            v.string(),
            v.description(
              "Browser-side JavaScript source defining top-level `async function discoverFields()` and `async function fillForm(profile)`. Must never submit or navigate. Ignored when state='abort'."
            )
          ),
          foundApplicationForm: v.pipe(
            v.boolean(),
            v.description(
              'True if the current DOM actually contains the fillable application form (text inputs, selects, etc.), not just a description with an Apply button.'
            )
          ),
          currentAction: v.pipe(
            v.string(),
            v.description(
              'One sentence starting with "I\'m..." describing this step.'
            )
          ),
          reason: v.pipe(
            v.string(),
            v.description(
              'One-line strategy summary, or — when aborting — specifically why the form cannot be reached/filled (name the Apply URL if there is one).'
            )
          ),
        }),
        maxAttempts: MAX_SCRIPT_ATTEMPTS,
        models,
        metadata: { configKey: 'LLM_FILL_FORM_MODEL' },
        logger: terminal,
        reasoningEffort: LlmReasoningEffort.High,
        validate: async (parsed, ctx) => {
          terminal.log(
            `[HARNESS] LLM (${ctx.model}): state=${parsed.state} | ${parsed.currentAction}\n[HARNESS] Reason: ${parsed.reason}\n[HARNESS] Script size: ${parsed.fillFormScript.length}`,
            COLOURS.cyan
          );

          if (parsed.state === 'abort') {
            throw new FillFormAbort(parsed.reason);
          }

          if (parsed.state === 'still_exploring') {
            const explore = await callFillFormScript(
              page,
              parsed.fillFormScript,
              { op: 'discover' }
            );

            return {
              valid: false,
              feedback:
                "state='still_exploring' — your script ran once against the current DOM. Console output and any error are below. Revise, then return state='validate' when ready." +
                formatCapture(explore),
            };
          }

          let probe: ValidateResult;
          try {
            probe = await validateFillScript({
              page,
              applicationUrl,
              script: parsed.fillFormScript,
              profile,
            });
          } catch (err) {
            // A harness-level throw (bad selector reaching querySelector, a
            // pageEval timeout, etc.) must not abort the whole generation —
            // turn it into feedback so the model can revise and retry.
            return {
              valid: false,
              feedback: `The validation harness errored while running your script: ${String(err).slice(0, 400)}. Ensure discoverFields() and fillForm() do not throw and that every selector is a valid CSS selector.`,
            };
          }

          if (probe.ok) {
            terminal.log(
              `[HARNESS] LLM (${ctx.model}): Script validated — filled ${probe.filledCount} field(s), ${probe.nonEmptyCount} confirmed non-empty after fill.`,
              COLOURS.green
            );
            return { valid: true, result: parsed.fillFormScript };
          }

          return { valid: false, feedback: probe.feedback };
        },
      });

      return result;
    } catch (error) {
      if (error instanceof FillFormAbort) {
        terminal.warn(
          `LLM aborted fill-form generation for ${applicationUrl}: ${error.message}`
        );
        return null;
      }

      terminal.error(`Error generating fill-form script: ${String(error)}`);
      return null;
    }
  });
}

async function loadPageSnapshot(
  page: Page,
  url: string
): Promise<{ title: string; html: string }> {
  await goToPage(page, url);
  const title = await page.title();
  const html = await cleanHtmlForLlm(page);
  return { title, html };
}

type ValidateResult =
  | { ok: true; filledCount: number; nonEmptyCount: number }
  | { ok: false; feedback: string };

/** Validate in a fresh tab: discover fields, run fillForm, then re-read the
 * form values to confirm the fill actually stuck. Fresh tab so no prior
 * mutation leaks in — same reasoning as the parser-script validator. */
async function validateFillScript(args: {
  page: Page;
  applicationUrl: string;
  script: string;
  profile: ApplicantProfile;
}): Promise<ValidateResult> {
  const { page: parentPage, applicationUrl, script, profile } = args;

  const page = await parentPage.context().newPage();
  try {
    await goToPage(page, applicationUrl);

    const discover = await callFillFormScript(page, script, { op: 'discover' });
    if (!discover.ok) {
      return {
        ok: false,
        feedback:
          'discoverFields() threw during validation:' + formatCapture(discover),
      };
    }

    const fill = await callFillFormScript(page, script, {
      op: 'fill',
      profile,
    });

    if (!fill.ok) {
      return {
        ok: false,
        feedback:
          'fillForm(profile) threw during validation:' + formatCapture(fill),
      };
    }

    const report = fill.result as FillFormReport | undefined;
    const filledCount = report?.filled?.length ?? 0;
    if (filledCount === 0) {
      return {
        ok: false,
        feedback:
          'fillForm(profile) returned no filled fields. Make sure you locate the form inputs and set their values (native setter + input/change events). Report and logs:' +
          `\n${JSON.stringify(report)?.slice(0, 1500)}` +
          formatCapture(fill),
      };
    }

    // Re-read the values off the DOM to confirm the fill actually stuck (a
    // report can claim success while a controlled input rejected the value).
    const reread = await rereadFormValues(
      page,
      (report?.filled ?? []).map(f => f.selector)
    );

    const nonEmptyCount = reread.filter(v => v.trim().length > 0).length;
    if (nonEmptyCount === 0) {
      return {
        ok: false,
        feedback:
          'fillForm reported filled fields, but re-reading their values off the DOM found them all still empty — the writes did not stick. Use the native value setter and dispatch both input and change events.' +
          formatCapture(fill),
      };
    }

    return { ok: true, filledCount, nonEmptyCount };
  } finally {
    await page.close();
  }
}

function formatCapture(capture: ScriptCapture): string {
  const logs =
    capture.logs.length > 0
      ? `\n\nConsole:\n${capture.logs.join('\n')}`
      : '\n\n(no console output)';

  const error = capture.ok ? '' : `\n\nThrew: ${capture.error}`;
  return logs + error;
}
