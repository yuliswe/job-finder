import { Command, Option } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'jobfinder.config.js';
import { Bool } from 'src/db/customTypes.js';
import { newId } from 'src/db/id.js';
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
  inScopeForViewing,
  qualifiedForViewing,
} from 'src/db/pipelineQualified.js';
import { evaluateJobLocationRelevancy } from 'src/llm/evaluateJobLocationRelevancy.js';
import { viewJobPost } from 'src/llm/viewJobPost.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { getUserInterests } from 'src/utils/userInterests.js';
import { terminal } from 'src/utils/terminal.js';

const tabLimit = pLimit(MAX_CONCURRENT_BROWSER_TABS);

type ViewingOptions = {
  all?: boolean;
  includeFailed?: boolean;
  jobPostId?: string;
  /** Process the selected rows now. Without it the command only queues
   * them for a later `--start` / `jobfinder start-pipeline`. */
  start?: boolean;
  /** Suppress "nothing to do" / "0 rows" logs. See SourcingOptions. */
  suppressNothingToDoLog?: boolean;
};

export function createViewingCommand(): Command {
  return new Command('viewing')
    .description(
      'For each currently-queued JobPost, open the URL and ask the LLM to populate title/company/location/description/salary/etc. fields. By default only queues the selected rows; pass --start to process them now.'
    )
    .addOption(
      new Option(
        '--all',
        'Re-view every qualifying in-scope JobPost regardless of pipeline state — including ones already done / not_a_job_posting / failed. Use after a prompt change.'
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
      'Re-view only the JobPost with this ID, regardless of pipeline state or qualification.'
    )
    .option(
      '--start',
      'Process the selected rows now. Without this flag the command only queues them for a later `--start` or `jobfinder start-pipeline`.'
    )
    .action(async (opts: ViewingOptions) => {
      if (opts.start) {
        await withBrowserInstance(context => runViewing(context, opts));
        return;
      }

      await queueViewing(opts);
    });
}

/** Enqueue any explicitly-requested row, apply --all's bulk requeue, and
 * return the rows the mode selects. Shared by the queue-only default path
 * and the --start processing path. */
async function pickViewingTargets(
  opts: ViewingOptions
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
      task: 'viewing',
      entity: { ofJobPostId: opts.jobPostId },
    });
  }

  // With --all, requeue every in-scope viewing row first. Going through
  // 'queued' (instead of just bypassing the eligibility filter) keeps the
  // TUI pipeline bar honest — the numerator sees them transition through
  // queued → started → done like any normal pickup.
  const mode = pipelineModeFromOptions(opts);
  if (mode === 'all') await requeueAllInScope('viewing');

  // Picker = qualifiedForX ∩ inScopeForX + state filter chosen by mode.
  const stateFilter = pickerStateFilter({
    task: 'viewing',
    parentIdRef: 'JobPost.id',
    mode,
  });

  let query = db
    .selectFrom('JobPost')
    .select(['JobPost.id as id', 'JobPost.url as url'])
    .where(qualifiedForViewing)
    .where(inScopeForViewing);

  if (stateFilter) query = query.where(stateFilter);

  return opts.jobPostId
    ? db
        .selectFrom('JobPost')
        .select(['JobPost.id as id', 'JobPost.url as url'])
        .where('JobPost.id', '=', opts.jobPostId)
        .execute()
    : query.execute();
}

export async function queueViewing(
  opts: ViewingOptions
): Promise<{ queued: number }> {
  const mode = pipelineModeFromOptions(opts);
  const targets = await pickViewingTargets(opts);

  // The default mode only selects rows that are already queued, --all
  // bulk-requeues inside the picker, and --job-post-id enqueues its row
  // explicitly — so only --include-failed's failed/aborted/no_result rows
  // still need a fresh queued state for a later --start to pick them up.
  if (mode === 'include-failed') {
    for (const target of targets) {
      await enqueuePipelineTask({
        task: 'viewing',
        entity: { ofJobPostId: target.id },
      });
    }
  }

  terminal.log(
    `${targets.length} JobPost row(s) queued for viewing. Pass --start (or \`jobfinder start-pipeline\`) to process them.`
  );

  return { queued: targets.length };
}

export async function runViewing(
  context: BrowserContext,
  opts: ViewingOptions
): Promise<{ processed: number }> {
  await reapStaleStartedStates('viewing');
  const targets = await pickViewingTargets(opts);

  if (targets.length === 0) {
    if (!opts.suppressNothingToDoLog) {
      terminal.log('No unprocessed JobPost rows. Nothing to do.');
    }

    return { processed: 0 };
  }

  // Loaded once and shared across tabs: the viewing stage scores each post's
  // location against the user's stated preferences to gate whether it proceeds
  // to `evaluate` (see `inScopeForEvaluate`).
  const interests = await getUserInterests();
  if (!interests) {
    terminal.warn(
      'No user interests found (data/interests.local.md or data/interests.md). locationRelevancy will default to 0.5 (neutral).'
    );
  }

  const results = await Promise.all(
    targets.map(target =>
      tabLimit(() => viewOneTarget({ context, target, interests }))
    )
  );

  const jobPostUpdated = results.reduce(
    (sum, r) => sum + (r?.jobPostUpdated ?? 0),
    0
  );

  if (jobPostUpdated > 0 || !opts.suppressNothingToDoLog) {
    terminal.log(`Viewed and updated ${jobPostUpdated} JobPost rows\n`);
  }

  return { processed: targets.length };
}

async function viewOneTarget(args: {
  context: BrowserContext;
  target: { id: string; url: string };
  interests: string;
}): Promise<{ jobPostUpdated: number } | undefined> {
  const { context, target, interests } = args;
  return processOne({
    task: 'viewing',
    entity: { ofJobPostId: target.id },
    label: target.url,
    work: async (): Promise<{ jobPostUpdated: number }> => {
      terminal.log(`Viewing JobPost ${target.url}`);

      const parsed = await viewJobPost({ context, url: target.url });

      if (!parsed) {
        await recordPipelineState({
          task: 'viewing',
          state: PIPELINE_STATE.FAILED,
          reason: 'viewJobPost returned null (page load or LLM call failed)',
          entity: { ofJobPostId: target.id },
        });
        return { jobPostUpdated: 0 };
      }

      if (!parsed.isJobPosting) {
        // LLM determined the URL is not a job posting (expired, login wall,
        // error page, listings page, etc.). Treat this as a terminal verdict
        // so we stop re-attempting it on every pipeline run.
        await recordPipelineState({
          task: 'viewing',
          state: PIPELINE_STATE.NOT_A_JOB_POSTING,
          reason: 'LLM reported the page is not a job posting',
          entity: { ofJobPostId: target.id },
        });
        return { jobPostUpdated: 0 };
      }

      const sortedSkillRequirements = [...parsed.skillRequirements].sort(
        (a, b) => b.importance - a.importance
      );

      const update: Record<string, unknown> = {
        company: parsed.company,
        description: parsed.description,
        isRemote:
          parsed.isRemote === null
            ? null
            : parsed.isRemote
              ? Bool.True
              : Bool.False,
        jobType: parsed.jobType,
        location: parsed.location,
        postedAt: parsed.postedAt,
        postedAtSource: parsed.postedAtSource,
        salaryCurrency: parsed.salaryCurrency,
        salaryInterval: parsed.salaryInterval,
        salaryMax: parsed.salaryMax,
        salaryMin: parsed.salaryMin,
        skillRequirements: JSON.stringify(sortedSkillRequirements),
        summary: parsed.summary,
      };

      // Only overwrite title if the LLM produced one — preserve the
      // run-scripts title as a fallback otherwise.
      if (parsed.title) update.title = parsed.title;

      await db
        .updateTable('JobPost')
        .set(update)
        .where('id', '=', target.id)
        .execute();

      // Score the extracted location against the user's stated preferences and
      // persist it on the eval row (which already exists from run-scripts with
      // titleRelavency). `inScopeForEvaluate` gates on this via
      // `PIPELINE_VIEWING_MIN_LOCATION_RELEVANCY`, so a below-threshold post is
      // viewed and recorded but never proceeds to evaluate / gets shown to the
      // user.
      const loc = await evaluateJobLocationRelevancy({
        interests,
        location: parsed.location,
        isRemote: parsed.isRemote,
      });

      await db
        .insertInto('JobPostEval')
        .values({
          id: newId(),
          ofJobPostId: target.id,
          locationRelevancy: loc.locationRelevancy,
          locationRelevancyReason: loc.locationRelevancyReason,
        })
        .onConflict(oc =>
          oc.column('ofJobPostId').doUpdateSet({
            locationRelevancy: loc.locationRelevancy,
            locationRelevancyReason: loc.locationRelevancyReason,
            updatedAt: new Date().toISOString(),
          })
        )
        .execute();

      await recordPipelineState({
        task: 'viewing',
        state: PIPELINE_STATE.DONE,
        entity: { ofJobPostId: target.id },
      });

      await enqueuePipelineTask({
        task: 'evaluate',
        entity: { ofJobPostId: target.id },
      });

      return { jobPostUpdated: 1 };
    },
  });
}
