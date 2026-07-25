import { type Page } from 'patchright';

import type {
  DiscoveredField,
  FillFormReport,
} from 'src/llm/generateFillFormScript.js';
import type { ApplicantProfile } from 'src/utils/applicantProfile.js';
import { pageEval } from 'src/utils/browser.js';

export type ScriptCapture =
  | { ok: true; result: unknown; logs: string[] }
  | { ok: false; error: string; logs: string[] };

/**
 * Run the stored fill-form script in `page` for one op — 'discover' returns the
 * field list, 'fill' runs `fillForm(profile)` — capturing console output and
 * any thrown error. This is the `new Function` harness the generated script is
 * documented to run under; both the generation validator and the interactive
 * runner go through it so the contract is identical in both.
 */
export async function callFillFormScript(
  page: Page,
  script: string,
  arg: { op: 'discover' } | { op: 'fill'; profile: ApplicantProfile }
): Promise<ScriptCapture> {
  return pageEval(
    page,
    async ({
      s,
      a,
    }: {
      s: string;
      a: { op: string; profile?: ApplicantProfile };
    }) => {
      const logs: string[] = [];
      const orig = {
        log: console.log,
        error: console.error,
        warn: console.warn,
      };

      console.log = (...xs: unknown[]) => logs.push(xs.map(String).join(' '));

      console.error = (...xs: unknown[]) =>
        logs.push('ERROR: ' + xs.map(String).join(' '));

      console.warn = (...xs: unknown[]) =>
        logs.push('WARN: ' + xs.map(String).join(' '));

      try {
        const fn = new Function(
          'args',
          `${s}\nreturn (args && args.op === 'discover') ? discoverFields() : fillForm(args.profile);`
        );

        const result = await fn(a);
        return { ok: true, result, logs };
      } catch (e) {
        const err = e as { stack?: string };
        return { ok: false, error: String(err?.stack ?? e), logs };
      } finally {
        console.log = orig.log;
        console.error = orig.error;
        console.warn = orig.warn;
      }
    },
    { s: script, a: arg },
    { timeoutMs: 60_000 }
  );
}

/** Read the current `value` (or checked state) of each selector off the live
 * DOM — used to confirm a fill actually stuck. Robust to malformed selectors
 * the LLM may report (e.g. a bare `name` value like `cards[uuid][field0]` that
 * is not a valid CSS selector): each lookup is wrapped so a bad selector yields
 * `''` instead of throwing and aborting the whole run, and a raw name is
 * retried as an attribute selector. Radios report the group's checked value. */
export async function rereadFormValues(
  page: Page,
  selectors: string[]
): Promise<string[]> {
  return pageEval(
    page,
    ({ sels }: { sels: string[] }) => {
      const esc = (s: string): string => s.replace(/"/g, '\\"');
      const resolve = (sel: string): Element | null => {
        try {
          const el = document.querySelector(sel);
          if (el) return el;
        } catch {
          // not a valid CSS selector — fall through to the name-attr retry
        }

        try {
          return document.querySelector(`[name="${esc(sel)}"]`);
        } catch {
          return null;
        }
      };

      return sels.map(sel => {
        const el = resolve(sel);
        if (!el) return '';

        if (el instanceof HTMLInputElement && el.type === 'radio') {
          let group: Element[] = [];
          try {
            group = Array.from(
              document.querySelectorAll(`[name="${esc(el.name)}"]`)
            );
          } catch {
            group = [];
          }

          const checked = group.find(
            r => r instanceof HTMLInputElement && r.checked
          ) as HTMLInputElement | undefined;

          return checked ? checked.value || 'checked' : '';
        }

        if (el instanceof HTMLInputElement && el.type === 'checkbox') {
          return el.checked ? 'checked' : '';
        }

        return (
          (el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)
            .value ?? ''
        );
      });
    },
    { sels: selectors },
    { timeoutMs: 15_000 }
  );
}

export type RunFillFormResult = {
  report: FillFormReport;
  discovered: DiscoveredField[];
  /** Per-filled-field value re-read off the DOM after the fill, so callers can
   * prove the inputs are populated (used by QA / the command's summary). */
  reread: { selector: string; label: string; value: string }[];
};

/**
 * Execute the stored fill-form script against the already-navigated `page`:
 * discover the fields, run `fillForm(profile)`, then re-read the values so the
 * caller can confirm the form is populated. Never submits and never closes the
 * page — the caller owns the (headed) browser so a human can review and submit.
 */
export async function runFillFormScript(args: {
  page: Page;
  script: string;
  profile: ApplicantProfile;
}): Promise<RunFillFormResult> {
  const { page, script, profile } = args;

  const discoverCapture = await callFillFormScript(page, script, {
    op: 'discover',
  });

  if (!discoverCapture.ok) {
    throw new Error(`discoverFields() threw: ${discoverCapture.error}`);
  }

  const discovered = (discoverCapture.result as DiscoveredField[]) ?? [];

  const fillCapture = await callFillFormScript(page, script, {
    op: 'fill',
    profile,
  });

  if (!fillCapture.ok) {
    throw new Error(`fillForm(profile) threw: ${fillCapture.error}`);
  }

  const report = (fillCapture.result as FillFormReport) ?? {
    filled: [],
    skipped: [],
  };

  const filled = report.filled ?? [];
  const values = await rereadFormValues(
    page,
    filled.map(f => f.selector)
  );

  const reread = filled.map((f, i) => ({
    selector: f.selector,
    label: f.label,
    value: values[i] ?? '',
  }));

  return { report, discovered, reread };
}
