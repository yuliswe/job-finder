import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { Command, Option } from 'commander';
import { chromium, type BrowserContext } from 'patchright';

import {
  upsertJobPost,
  upsertJobSourceByName,
} from 'src/db/bootstrapJobPost.js';
import { db } from 'src/db/index.js';
import { enqueuePipelineTask } from 'src/db/pipelineState.js';
import { generateAndStoreFillForm } from 'src/cli/commands/pipeline/fill-form.js';
import { classifyTrackedUrl } from 'src/llm/classifyTrackedUrl.js';
import { runFillFormScript } from 'src/llm/runFillFormScript.js';
import { loadApplicantProfile } from 'src/utils/applicantProfile.js';
import { goToPage } from 'src/utils/browser.js';
import { RESUME_OUTPUT_DIR } from 'src/utils/config.js';
import { terminal } from 'src/utils/terminal.js';

type FillFormCommandOptions = {
  regenerate?: boolean;
  generateOnly?: boolean;
  bootstrap?: boolean;
  headed?: boolean;
  headless?: boolean;
  screenshot?: string;
};

export function createFillFormCommand(): Command {
  return new Command('fill-form')
    .description(
      'Open a job application form and auto-fill it from your applicant profile (data/profile.local.md), WITHOUT submitting. Given a JobPost id it fills that post; given a URL it find-or-creates the post (bootstrapping a placeholder company + queuing sourcing/viewing) first. Caches the generated fill script on JobPost.fillFormScript.'
    )
    .argument(
      '<jobPostIdOrUrl>',
      'A JobPost id, or the URL of a job application form / posting.'
    )
    .addOption(
      new Option(
        '--regenerate',
        'Discard any cached fillFormScript and generate a fresh one.'
      )
    )
    .addOption(
      new Option(
        '--generate-only',
        'Generate and store the fill script but do not open the interactive fill.'
      )
    )
    .addOption(
      new Option(
        '--no-bootstrap',
        'When given a URL with no existing JobPost, fail instead of creating one.'
      )
    )
    .addOption(
      new Option('--headed', 'Force a visible browser for the fill (default).')
    )
    .addOption(
      new Option(
        '--headless',
        'Run the fill in a headless browser (still screenshots + reports the filled values).'
      )
    )
    .option(
      '--screenshot <path>',
      'Where to write a screenshot of the filled form. Defaults to <RESUME_OUTPUT_DIR>/fill-form-<jobPostId>.png.'
    )
    .action(async (arg: string, opts: FillFormCommandOptions) => {
      await runFillFormCommand(arg, opts);
    });
}

async function runFillFormCommand(
  arg: string,
  opts: FillFormCommandOptions
): Promise<void> {
  const profile = await loadApplicantProfile();

  // Force headed by default (a human reviews + submits); --headless overrides.
  const headless = opts.headless === true;

  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext();
    try {
      const post = await resolveJobPost(context, arg, opts);

      let script = await getStoredScript(post.id);
      if (!script || opts.regenerate) {
        script = await generateAndStoreFillForm({
          context,
          jobPostId: post.id,
          url: post.url,
          profile,
        });

        if (!script) {
          terminal.error(
            `Could not generate a fill-form script for ${post.url}. See the LLM/harness output above.`
          );

          process.exitCode = 1;
          return;
        }
      } else {
        terminal.log(
          `Using cached fill-form script for JobPost ${post.id} (pass --regenerate to rebuild).`
        );
      }

      if (opts.generateOnly) {
        terminal.log(
          `Stored fill-form script for JobPost ${post.id}. Skipping interactive fill (--generate-only).`
        );

        return;
      }

      await performInteractiveFill({
        context,
        post,
        script,
        profile,
        headless,
        screenshotOpt: opts.screenshot,
      });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function getStoredScript(jobPostId: string): Promise<string | null> {
  const row = await db
    .selectFrom('JobPost')
    .select('fillFormScript')
    .where('id', '=', jobPostId)
    .executeTakeFirst();

  return row?.fillFormScript ?? null;
}

async function performInteractiveFill(args: {
  context: BrowserContext;
  post: { id: string; url: string };
  script: string;
  profile: Awaited<ReturnType<typeof loadApplicantProfile>>;
  headless: boolean;
  screenshotOpt?: string;
}): Promise<void> {
  const { context, post, script, profile, headless, screenshotOpt } = args;

  const page = await context.newPage();
  await goToPage(page, post.url);

  terminal.log(`Filling the form at ${post.url} …`);
  const { report, discovered, reread } = await runFillFormScript({
    page,
    script,
    profile,
  });

  const screenshotPath = resolve(
    screenshotOpt ?? join(RESUME_OUTPUT_DIR, `fill-form-${post.id}.png`)
  );

  await mkdir(dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  terminal.log(
    `\nDiscovered ${discovered.length} field(s); fillForm filled ${report.filled.length}, skipped ${report.skipped.length}.`
  );

  terminal.log('\nFilled values (re-read from the live form):');
  for (const f of reread) {
    const shown = f.value.length > 80 ? f.value.slice(0, 77) + '…' : f.value;
    terminal.log(`  • ${f.label || f.selector}: ${JSON.stringify(shown)}`);
  }

  if (report.skipped.length > 0) {
    terminal.log('\nSkipped:');
    for (const s of report.skipped) {
      terminal.log(`  • ${s.label || s.selector}: ${s.reason}`);
    }
  }

  terminal.log(`\nScreenshot written to ${screenshotPath}`);

  terminal.log(
    'The form was filled but NOT submitted. Review it and submit manually.'
  );

  if (!headless) {
    terminal.log(
      '\nLeaving the browser open for review; press Ctrl+C when done.'
    );

    // Keep the headed window open for the human; never resolves — the user
    // ends the process with Ctrl+C after reviewing/submitting.
    await new Promise<void>(() => {
      /* intentionally never resolves */
    });
  }
}

function looksLikeUrl(arg: string): boolean {
  return /^https?:\/\//i.test(arg.trim());
}

/** Resolve the target JobPost: by id if it exists, else by URL (find-or-create
 * via the bottom-up bootstrap). */
async function resolveJobPost(
  context: BrowserContext,
  arg: string,
  opts: FillFormCommandOptions
): Promise<{ id: string; url: string }> {
  const byId = await db
    .selectFrom('JobPost')
    .select(['id', 'url'])
    .where('id', '=', arg)
    .executeTakeFirst();

  if (byId) return byId;

  if (!looksLikeUrl(arg)) {
    throw new Error(
      `No JobPost with id "${arg}", and it is not a URL. Pass a JobPost id or an http(s) URL.`
    );
  }

  const url = arg.trim();
  const existing = await db
    .selectFrom('JobPost')
    .select(['id', 'url'])
    .where('url', '=', url)
    .executeTakeFirst();

  if (existing) return existing;

  if (opts.bootstrap === false) {
    throw new Error(
      `No JobPost exists for ${url} and --no-bootstrap was set; refusing to create one.`
    );
  }

  return bootstrapFromUrl(context, url);
}

/** Create the JobPost leaf, a placeholder JobSource parent, and queue the
 * standard enrichment tasks — the bottom-up bootstrap. */
async function bootstrapFromUrl(
  context: BrowserContext,
  url: string
): Promise<{ id: string; url: string }> {
  const companyName = await resolveCompanyName(context, url);

  const jobSourceId = await upsertJobSourceByName(companyName);
  const jobPostId = await upsertJobPost({
    url,
    ofJobSourceId: jobSourceId,
    reason: 'Created via `jobfinder fill-form`.',
  });

  await enqueuePipelineTask({
    task: 'sourcing',
    entity: { ofJobSourceId: jobSourceId },
  });

  await enqueuePipelineTask({
    task: 'viewing',
    entity: { ofJobPostId: jobPostId },
  });

  terminal.log(
    `Bootstrapped JobPost ${jobPostId} for "${companyName}" — queued sourcing on the company and viewing on the post (evaluate follows viewing).`
  );

  return { id: jobPostId, url };
}

/** Best-effort company name for the placeholder JobSource: ask the classifier,
 * falling back to the URL hostname when it can't tell (fill-form is pointed at
 * a form deliberately, so — unlike `track` — we do not hard-fail on 'none'). */
async function resolveCompanyName(
  context: BrowserContext,
  url: string
): Promise<string> {
  try {
    const classification = await classifyTrackedUrl({ context, url });
    if (classification?.companyName) return classification.companyName;
  } catch (err) {
    terminal.warn(`Could not classify ${url}: ${String(err)}`);
  }

  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
