import { Command } from 'commander';
import pLimit from 'p-limit';

import { jobPostInActiveSource } from 'src/db/activeSource.js';
import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import { processOne, recordPipelineState } from 'src/db/pipelineState.js';
import { markTriggerProcessed } from 'src/db/pipelineTrigger.js';
import { evaluateJobPost } from 'src/llm/evaluateJobPost.js';
import { terminal } from 'src/utils/terminal.js';
import { getUserCV, getUserInterests } from 'src/utils/userInterests.js';

// Evaluation is pure LLM work — no browser needed. Cap concurrency to avoid
// hammering the LLM provider.
const CONCURRENCY = 5;
const limit = pLimit(CONCURRENCY);

export function createEvaluateCommand(): Command {
  return new Command('evaluate')
    .description(
      'For each viewed JobPost (description populated), score interest + skill against seeds/interests.md and seeds/cv.md and upsert the result into JobPostEval.'
    )
    .action(() => runEvaluate());
}

async function runEvaluate(): Promise<void> {
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

  const targets = await db
    .selectFrom('JobPost')
    .select(['id', 'title', 'description'])
    .where('description', 'is not', null)
    .where(jobPostInActiveSource)
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
  target: { id: string; title: string; description: string | null };
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

      terminal.log(`Evaluating "${target.title}" (${target.id})`);

      const eva = await evaluateJobPost({
        interests,
        cv,
        job: { title: target.title, description: target.description },
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
        state: 'done',
        entity: { ofJobPostId: target.id },
      });
      await markTriggerProcessed({
        task: 'evaluate',
        entity: { ofJobPostId: target.id },
      });
      return { jobPostEvaluated: 1 };
    },
  });
}
