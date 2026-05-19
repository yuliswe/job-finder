import { Command, Option } from 'commander';
import pLimit from 'p-limit';

import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import {
  eligibleForPipelineTask,
  enqueuePipelineTask,
  PIPELINE_STATE,
  processOne,
  recordPipelineState,
  requeueAllTerminal,
} from 'src/db/pipelineState.js';
import { qualifiedForEvaluate } from 'src/db/pipelineQualified.js';
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
  jobPostId?: string;
};

export function createEvaluateCommand(): Command {
  return new Command('evaluate')
    .description(
      'For each viewed JobPost (description populated), score interest + skill against seeds/interests.md and seeds/cv.md and upsert the result into JobPostEval.'
    )
    .addOption(
      new Option(
        '--all',
        'Re-evaluate every qualifying JobPost regardless of pipeline state. Useful after a prompt change.'
      )
    )
    .option(
      '--job-post-id <id>',
      'Re-evaluate only the JobPost with this ID, regardless of pipeline state or qualification.'
    )
    .action((opts: EvaluateOptions) => runEvaluate(opts));
}

async function runEvaluate(opts: EvaluateOptions): Promise<void> {
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
  } else if (opts.all) {
    await requeueAllTerminal('evaluate');
  }

  const [interests, cv] = await Promise.all([getUserInterests(), getUserCV()]);

  if (!interests) {
    terminal.warn(
      'No user interests found (seeds/interests.local.md or seeds/interests.md). interestScore will be unreliable.'
    );
  }

  if (!cv) {
    terminal.warn(
      'No CV found (seeds/cv.local.md or seeds/cv.md). skillScore will be unreliable.'
    );
  }

  const targets = opts.jobPostId
    ? await db
        .selectFrom('JobPost')
        .select(['id', 'title', 'description', 'skillRequirements'])
        .where('JobPost.id', '=', opts.jobPostId)
        .execute()
    : await db
        .selectFrom('JobPost')
        .select(['id', 'title', 'description', 'skillRequirements'])
        .where(qualifiedForEvaluate)
        .where(
          eligibleForPipelineTask({
            task: 'evaluate',
            parentIdRef: 'JobPost.id',
          })
        )
        .execute();

  if (targets.length === 0) {
    terminal.log(
      'No viewed JobPost rows with a description. Run `pipeline viewing` first.'
    );
    return;
  }

  const results = await Promise.all(
    targets.map(target => limit(() => evaluateOne({ target, interests, cv })))
  );

  const jobPostEvaluated = results.reduce(
    (sum, r) => sum + (r?.jobPostEvaluated ?? 0),
    0
  );

  terminal.log(`Evaluated ${jobPostEvaluated}/${targets.length} JobPost rows`);
}

async function evaluateOne(args: {
  target: {
    id: string;
    title: string;
    description: string | null;
    skillRequirements: string | null;
  };
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
        job: { title: target.title, description: target.description },
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
        })
        .onConflict(oc =>
          oc.column('ofJobPostId').doUpdateSet({
            interestScore: eva.interestScore,
            interestScoreReason: eva.interestScoreReason,
            skillScore: eva.skillScore,
            skillScoreReason: eva.skillScoreReason,
            skillScoreBreakdown: JSON.stringify(eva.skillScoreBreakdown),
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
