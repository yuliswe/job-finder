import { Command, Option } from 'commander';
import pLimit from 'p-limit';

import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import {
  enqueuePipelineTask,
  PIPELINE_STATE,
  parentsSettledForPipelineTask,
  pickerStateFilter,
  pipelineModeFromOptions,
  processOne,
  reapStaleStartedStates,
  recordPipelineState,
  requeueAllInScope,
} from 'src/db/pipelineState.js';
import {
  inScopeForEvaluate,
  qualifiedForEvaluate,
} from 'src/db/pipelineQualified.js';
import { evaluateJobPost } from 'src/llm/evaluateJobPost.js';
import type { SkillRequirements } from 'src/llm/viewJobPost.js';
import { terminal } from 'src/utils/terminal.js';
import { getUserCV, getUserInterests } from 'src/utils/userInterests.js';

// Evaluation is pure LLM work — no browser needed. Cap concurrency to avoid
// hammering the LLM provider.
const CONCURRENCY = 5;
const limit = pLimit(CONCURRENCY);

type EvaluateOptions = {
  all?: boolean;
  includeFailed?: boolean;
  jobPostId?: string;
  /** Process the selected rows now. Without it the command only queues
   * them for a later `--start` / `jobfinder start-pipeline`. */
  start?: boolean;
  /** Suppress "nothing to do" / "0 rows" logs. See SourcingOptions. */
  suppressNothingToDoLog?: boolean;
};

type EvaluateTarget = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  isRemote: number | null;
  skillRequirements: string | null;
};

export function createEvaluateCommand(): Command {
  return new Command('evaluate')
    .description(
      'For each currently-queued viewed JobPost, score interest + skill against data/interests.md and data/cv.md and upsert the result into JobPostEval. By default only queues the selected rows; pass --start to process them now.'
    )
    .addOption(
      new Option(
        '--all',
        'Re-evaluate every qualifying in-scope JobPost regardless of pipeline state. Use after a prompt change.'
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
      'Re-evaluate only the JobPost with this ID, regardless of pipeline state or qualification.'
    )
    .option(
      '--start',
      'Process the selected rows now. Without this flag the command only queues them for a later `--start` or `jobfinder start-pipeline`.'
    )
    .action(async (opts: EvaluateOptions) => {
      if (opts.start) {
        await runEvaluate(opts);
        return;
      }

      await queueEvaluate(opts);
    });
}

/** Enqueue any explicitly-requested row, apply --all's bulk requeue, and
 * return the rows the mode selects. Shared by the queue-only default path
 * and the --start processing path. */
async function pickEvaluateTargets(
  opts: EvaluateOptions
): Promise<EvaluateTarget[]> {
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
      task: 'evaluate',
      entity: { ofJobPostId: opts.jobPostId },
    });
  }

  const mode = pipelineModeFromOptions(opts);
  if (mode === 'all') await requeueAllInScope('evaluate');

  // Picker = qualifiedForX ∩ inScopeForX + state filter chosen by mode.
  const stateFilter = pickerStateFilter({
    task: 'evaluate',
    parentIdRef: 'JobPost.id',
    mode,
  });

  const selectCols = [
    'id',
    'title',
    'description',
    'location',
    'isRemote',
    'skillRequirements',
  ] as const;

  let query = db
    .selectFrom('JobPost')
    .select(selectCols)
    .where(qualifiedForEvaluate)
    .where(inScopeForEvaluate)
    // Hold evaluate while a fresh viewing is still pending on the same post, so
    // we never score a stale description that viewing is about to overwrite.
    // Applied in every mode (correctness, not a state filter); the explicit
    // --job-post-id branch below bypasses it as a deliberate manual override.
    .where(
      parentsSettledForPipelineTask({
        task: 'evaluate',
        parentIdRef: 'JobPost.id',
      })
    );

  if (stateFilter) query = query.where(stateFilter);

  return opts.jobPostId
    ? db
        .selectFrom('JobPost')
        .select(selectCols)
        .where('JobPost.id', '=', opts.jobPostId)
        .execute()
    : query.execute();
}

export async function queueEvaluate(
  opts: EvaluateOptions
): Promise<{ queued: number }> {
  const mode = pipelineModeFromOptions(opts);
  const targets = await pickEvaluateTargets(opts);

  // The default mode only selects rows that are already queued, --all
  // bulk-requeues inside the picker, and --job-post-id enqueues its row
  // explicitly — so only --include-failed's failed/aborted/no_result rows
  // still need a fresh queued state for a later --start to pick them up.
  if (mode === 'include-failed') {
    for (const target of targets) {
      await enqueuePipelineTask({
        task: 'evaluate',
        entity: { ofJobPostId: target.id },
      });
    }
  }

  terminal.log(
    `${targets.length} JobPost row(s) queued for evaluate. Pass --start (or \`jobfinder start-pipeline\`) to process them.`
  );

  return { queued: targets.length };
}

export async function runEvaluate(
  opts: EvaluateOptions
): Promise<{ processed: number }> {
  await reapStaleStartedStates('evaluate');
  const targets = await pickEvaluateTargets(opts);

  if (targets.length === 0) {
    if (!opts.suppressNothingToDoLog) {
      terminal.log(
        'No viewed JobPost rows with a description. Run `pipeline viewing` first.'
      );
    }

    return { processed: 0 };
  }

  const [interests, cv] = await Promise.all([getUserInterests(), getUserCV()]);

  if (!interests) {
    terminal.warn(
      'No user interests found (data/interests.local.md or data/interests.md). interestScore will be unreliable.'
    );
  }

  if (!cv) {
    terminal.warn(
      'No CV found (data/cv.local.md or data/cv.md). skillScore will be unreliable.'
    );
  }

  const results = await Promise.all(
    targets.map(target => limit(() => evaluateOne({ target, interests, cv })))
  );

  const jobPostEvaluated = results.reduce(
    (sum, r) => sum + (r?.jobPostEvaluated ?? 0),
    0
  );

  if (jobPostEvaluated > 0 || !opts.suppressNothingToDoLog) {
    terminal.log(
      `Evaluated ${jobPostEvaluated}/${targets.length} JobPost rows`
    );
  }

  return { processed: targets.length };
}

async function evaluateOne(args: {
  target: EvaluateTarget;
  interests: string;
  cv: string;
}): Promise<{ jobPostEvaluated: number } | undefined> {
  const { target, interests, cv } = args;
  return processOne({
    task: 'evaluate',
    entity: { ofJobPostId: target.id },
    label: `"${target.title}" (${target.id})`,
    work: async (): Promise<{ jobPostEvaluated: number }> => {
      if (!target.description) {
        throw new Error(`JobPost ${target.id} has no description`);
      }

      const skillRequirements: SkillRequirements = target.skillRequirements
        ? JSON.parse(target.skillRequirements)
        : [];

      terminal.log(`Evaluating "${target.title}" (${target.id})`);

      const eva = await evaluateJobPost({
        interests,
        cv,
        job: {
          title: target.title,
          description: target.description,
          location: target.location,
          isRemote: target.isRemote,
        },
        skillRequirements,
      });

      await db
        .insertInto('JobPostEval')
        .values({
          id: newId(),
          ofJobPostId: target.id,
          interestScore: eva.interestScore,
          interestScoreReason: eva.interestScoreReason,
          skillScore: eva.skillScore,
          skillScoreReason: eva.skillScoreReason,
          skillScoreBreakdown: JSON.stringify(eva.skillScoreBreakdown),
          locationScore: eva.locationScore,
          locationScoreReason: eva.locationScoreReason,
        })
        .onConflict(oc =>
          oc.column('ofJobPostId').doUpdateSet({
            interestScore: eva.interestScore,
            interestScoreReason: eva.interestScoreReason,
            skillScore: eva.skillScore,
            skillScoreReason: eva.skillScoreReason,
            skillScoreBreakdown: JSON.stringify(eva.skillScoreBreakdown),
            locationScore: eva.locationScore,
            locationScoreReason: eva.locationScoreReason,
            updatedAt: new Date().toISOString(),
          })
        )
        .execute();

      await recordPipelineState({
        task: 'evaluate',
        state: PIPELINE_STATE.DONE,
        entity: { ofJobPostId: target.id },
      });
      return { jobPostEvaluated: 1 };
    },
  });
}
