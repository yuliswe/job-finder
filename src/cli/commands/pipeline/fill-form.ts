import { Command, Option } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import {
  LLM_FILL_FORM_MODEL,
  MAX_CONCURRENT_BROWSER_TABS,
} from 'src/utils/config.js';
import { db } from 'src/db/index.js';
import {
  enqueuePipelineTask,
  PIPELINE_STATE,
  pickerStateFilter,
  pipelineModeFromOptions,
  processOne,
  reapStaleStartedStates,
  recordPipelineState,
  requeueAllInScope,
} from 'src/db/pipelineState.js';
import {
  inScopeForFillForm,
  qualifiedForFillForm,
} from 'src/db/pipelineQualified.js';
import { generateFillFormScript } from 'src/llm/generateFillFormScript.js';
import {
  loadApplicantProfile,
  type ApplicantProfile,
} from 'src/utils/applicantProfile.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';

const tabLimit = pLimit(MAX_CONCURRENT_BROWSER_TABS);

type FillFormOptions = {
  all?: boolean;
  includeFailed?: boolean;
  jobPostId?: string;
  /** Process the selected rows now. Without it the command only queues them. */
  start?: boolean;
  /** Suppress "nothing to do" / "0 rows" log lines. */
  suppressNothingToDoLog?: boolean;
};

export function createFillFormStageCommand(): Command {
  return new Command('fill-form')
    .description(
      'Generate and store a résumé fill-form script (discoverFields + fillForm) for each currently-queued JobPost and save it in JobPost.fillFormScript. Never submits. This stage is NOT run by `start-pipeline`; queue posts explicitly (e.g. via `jobfinder fill-form <id|url>`). By default only queues the selected rows; pass --start to process them now.'
    )
    .addOption(
      new Option(
        '--all',
        'Re-process every qualifying in-scope JobPost regardless of pipeline state, overwriting fillFormScript on success. Use after a prompt change.'
      )
    )
    .addOption(
      new Option(
        '--include-failed',
        'Also retry rows in failed / aborted / no_result state (default skips them). Mutually exclusive with --all.'
      )
    )
    .option(
      '--job-post-id <id>',
      'Re-process only the JobPost with this ID, regardless of pipeline state or qualification.'
    )
    .option(
      '--start',
      'Process the selected rows now. Without this flag the command only queues them for a later `--start`.'
    )
    .action(async (opts: FillFormOptions) => {
      if (opts.start) {
        await withBrowserInstance(context => runFillForm(context, opts));
        return;
      }

      await queueFillForm(opts);
    });
}

async function pickFillFormTargets(
  opts: FillFormOptions
): Promise<{ id: string; url: string }[]> {
  if (opts.jobPostId) {
    const exists = await db
      .selectFrom('JobPost')
      .select('id')
      .where('id', '=', opts.jobPostId)
      .executeTakeFirst();

    if (!exists) {
      throw new Error(`JobPost with id ${opts.jobPostId} not found.`);
    }

    await enqueuePipelineTask({
      task: 'fill-form',
      entity: { ofJobPostId: opts.jobPostId },
    });

    return db
      .selectFrom('JobPost')
      .select(['id', 'url'])
      .where('JobPost.id', '=', opts.jobPostId)
      .execute();
  }

  const mode = pipelineModeFromOptions(opts);
  if (mode === 'all') await requeueAllInScope('fill-form');

  const stateFilter = pickerStateFilter({
    task: 'fill-form',
    parentIdRef: 'JobPost.id',
    mode,
  });

  let query = db
    .selectFrom('JobPost')
    .select(['id', 'url'])
    .where(qualifiedForFillForm)
    .where(inScopeForFillForm);

  if (stateFilter) query = query.where(stateFilter);

  return query.execute();
}

export async function queueFillForm(
  opts: FillFormOptions
): Promise<{ queued: number }> {
  const mode = pipelineModeFromOptions(opts);
  const targets = await pickFillFormTargets(opts);

  if (mode === 'include-failed') {
    for (const target of targets) {
      await enqueuePipelineTask({
        task: 'fill-form',
        entity: { ofJobPostId: target.id },
      });
    }
  }

  terminal.log(
    `${targets.length} JobPost row(s) queued for fill-form. Pass --start to process them, or run \`jobfinder fill-form <id|url>\`.`
  );

  return { queued: targets.length };
}

export async function runFillForm(
  context: BrowserContext,
  opts: FillFormOptions
): Promise<{ processed: number }> {
  await reapStaleStartedStates('fill-form');
  const targets = await pickFillFormTargets(opts);

  if (targets.length === 0) {
    if (!opts.suppressNothingToDoLog) {
      terminal.log('No JobPost rows queued for fill-form. Nothing to do.');
    }

    return { processed: 0 };
  }

  const profile = await loadApplicantProfile();

  const results = await Promise.all(
    targets.map(target =>
      tabLimit(() => fillFormOneTarget({ context, target, profile }))
    )
  );

  const updated = results.reduce((sum, r) => sum + (r?.updated ?? 0), 0);

  if (updated > 0 || !opts.suppressNothingToDoLog) {
    terminal.log(`Stored ${updated} JobPost fill-form script(s)\n`);
  }

  return { processed: targets.length };
}

async function fillFormOneTarget(args: {
  context: BrowserContext;
  target: { id: string; url: string };
  profile: ApplicantProfile;
}): Promise<{ updated: number } | undefined> {
  const { context, target, profile } = args;
  return processOne({
    task: 'fill-form',
    entity: { ofJobPostId: target.id },
    label: target.url,
    work: async (): Promise<{ updated: number }> => {
      const script = await generateAndStoreFillForm({
        context,
        jobPostId: target.id,
        url: target.url,
        profile,
      });

      return { updated: script ? 1 : 0 };
    },
  });
}

/**
 * Generate a fill-form script for one JobPost and persist it to
 * `JobPost.fillFormScript`, recording the pipeline state. Returns the script on
 * success, or null when the LLM could not produce one (records ABORTED).
 * Shared by the stage runner and the top-level `fill-form` command.
 *
 * The caller is responsible for the surrounding pipeline-state `started` marker
 * when it needs one (the stage runner wraps this in `processOne`); the
 * top-level command calls it directly and reads the return value.
 */
export async function generateAndStoreFillForm(args: {
  context: BrowserContext;
  jobPostId: string;
  url: string;
  profile: ApplicantProfile;
}): Promise<string | null> {
  const { context, jobPostId, url, profile } = args;

  terminal.log(
    `Generating fill-form script for ${url} (models=${LLM_FILL_FORM_MODEL.join(',')})`
  );

  const script = await generateFillFormScript({
    context,
    applicationUrl: url,
    profile,
  });

  if (!script) {
    terminal.warn(
      `LLM_FILL_FORM_MODEL could not produce a validated fill-form script for ${url} — leaving unprocessed for retry`
    );

    await recordPipelineState({
      task: 'fill-form',
      state: PIPELINE_STATE.ABORTED,
      reason:
        'generateFillFormScript returned null (LLM aborted or exhausted attempts)',
      entity: { ofJobPostId: jobPostId },
    });
    return null;
  }

  await db
    .updateTable('JobPost')
    .set({ fillFormScript: script })
    .where('id', '=', jobPostId)
    .execute();

  await recordPipelineState({
    task: 'fill-form',
    state: PIPELINE_STATE.DONE,
    entity: { ofJobPostId: jobPostId },
  });

  return script;
}
