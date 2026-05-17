import { Command } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'jobfinder.config.js';
import { Bool } from 'src/db/customTypes.js';
import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import { recordPipelineState } from 'src/db/pipelineState.js';
import {
  enqueueTrigger,
  markTriggerProcessed,
} from 'src/db/pipelineTrigger.js';
import {
  batchEvaluateJobTitlesRelevancy,
  type JobRelevanceScore,
} from 'src/llm/batchEvaluateJobTitlesRelevancy.js';
import { runParserScript } from 'src/llm/runParserScript.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';
import { getUserInterests } from 'src/utils/userInterests.js';

const tabLimit = pLimit(MAX_CONCURRENT_BROWSER_TABS);

export function createRunScriptsCommand(): Command {
  return new Command('run-scripts')
    .description(
      'For every JobListSource with a validated parserScript, ask the LLM to map the supplied division/location to the page filter options, then run searchJobs and insert the matching jobs into JobPost'
    )
    .requiredOption(
      '-d, --division <division>',
      'Division/department to filter by (e.g. "engineering")'
    )
    .requiredOption(
      '-l, --location <location>',
      'Location to filter by (e.g. "Toronto, ON")'
    )
    .action(async (opts: { division: string; location: string }) => {
      await withBrowserInstance(context =>
        runAll(context, { division: opts.division, location: opts.location })
      );
    });
}

async function runAll(
  context: BrowserContext,
  args: { division: string; location: string }
): Promise<void> {
  const targets = await db
    .selectFrom('JobListSource')
    .select(['id', 'url', 'parserScript', 'ofJobSourceId'])
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('PipelineTrigger')
            .select('PipelineTrigger.id')
            .whereRef(
              'PipelineTrigger.ofJobListSourceId',
              '=',
              'JobListSource.id'
            )
            .where('PipelineTrigger.task', '=', 'run-scripts')
            .where('PipelineTrigger.isProcessed', '=', Bool.True)
        )
      )
    )
    .where('parserScript', 'is not', null)
    .execute();

  if (targets.length === 0) {
    terminal.log(
      'No JobListSource rows with a validated parserScript. Nothing to do.'
    );
    return;
  }

  const interests = await getUserInterests();
  if (!interests) {
    terminal.warn(
      'No user interests found (seeds/interests.local.md or seeds/interests.md). Relevance scores will all be neutral (0.5).'
    );
  }

  let totalInserted = 0;
  await Promise.all(
    targets.map(target =>
      tabLimit(async () => {
        totalInserted += await processTarget(context, target, args, interests);
      })
    )
  );

  terminal.log(`Inserted ${totalInserted} rows into JobPost\n`);
}

async function processTarget(
  context: BrowserContext,
  target: {
    id: string;
    url: string;
    parserScript: string | null;
    ofJobSourceId: string;
  },
  args: { division: string; location: string },
  interests: string
): Promise<number> {
  if (!target.parserScript) return 0; // filtered above but TS narrowing

  terminal.log(`Running parserScript for ${target.url}`);

  const result = await runParserScript({
    context,
    listingUrl: target.url,
    script: target.parserScript,
    userLocation: args.location,
    userDivision: args.division,
  });

  if (!result.ok && result.reason === 'script_error') {
    terminal.error(`script_error for ${target.url}: ${result.error}`);
    await recordPipelineState({
      task: 'run-scripts',
      state: 'script_error',
      reason: result.error,
      entity: { ofJobListSourceId: target.id },
    });
    return 0;
  }

  if (!result.ok && result.reason === 'no_result_found') {
    terminal.warn(
      `no_result_found for ${target.url} (picked ${JSON.stringify(result.picked)})`
    );
    await recordPipelineState({
      task: 'run-scripts',
      state: 'no_result_found',
      reason: `picked locations=${JSON.stringify(result.picked.locations)} divisions=${JSON.stringify(result.picked.divisions)}`,
      entity: { ofJobListSourceId: target.id },
    });
    return 0;
  }

  if (!result.ok) return 0; // exhaustive but TS narrowing

  // Score TITLE relevance in a single batched LLM call before insertion.
  let scores: JobRelevanceScore[];
  try {
    scores = await batchEvaluateJobTitlesRelevancy({
      interests,
      candidates: result.jobs,
    });
  } catch (err) {
    terminal.error(
      `batchEvaluateJobTitlesRelevancy failed for ${target.url}: ${String(err)}`
    );
    // Fall back to neutral scores so insertion still proceeds.
    scores = result.jobs.map(() => ({
      titleRelavency: 0.5,
      titleRelavencyReason: `batchEvaluateJobTitlesRelevancy failed: ${String(err).slice(0, 200)}`,
    }));
  }

  const inserted = await insertJobsWithScores({
    jobs: result.jobs,
    scores,
    ofJobSourceId: target.ofJobSourceId,
    ofJobListSourceId: target.id,
  });

  await recordPipelineState({
    task: 'run-scripts',
    state: 'success',
    reason: `${inserted}/${result.jobs.length} new JobPost rows`,
    entity: { ofJobListSourceId: target.id },
  });
  await markTriggerProcessed({
    task: 'run-scripts',
    entity: { ofJobListSourceId: target.id },
  });

  return inserted;
}

async function insertJobsWithScores(args: {
  jobs: { jobTitle: string; url: string }[];
  scores: JobRelevanceScore[];
  ofJobSourceId: string;
  ofJobListSourceId: string;
}): Promise<number> {
  const { jobs, scores, ofJobSourceId, ofJobListSourceId } = args;
  let inserted = 0;
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i]!;
    const score = scores[i]!;
    try {
      const newJobId = newId();
      const result = await db
        .insertInto('JobPost')
        .values({
          id: newJobId,
          url: j.url,
          title: j.jobTitle,
          ofJobSourceId,
          ofJobListSourceId,
        })
        .onConflict(oc => oc.column('url').doNothing())
        .executeTakeFirst();

      const wasInserted = (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
      if (wasInserted) inserted++;

      // Resolve the JobPost.id we should hang the eval off of. For brand-new
      // rows it's `newJobId`; for duplicate URLs we look up the existing one.
      let jobPostId: string;
      if (wasInserted) {
        jobPostId = newJobId;
        await enqueueTrigger({
          task: 'viewing',
          entity: { ofJobPostId: newJobId },
        });
      } else {
        const existing = await db
          .selectFrom('JobPost')
          .select('id')
          .where('url', '=', j.url)
          .executeTakeFirst();
        if (!existing) continue;
        jobPostId = existing.id;
      }

      await db
        .insertInto('JobPostEval')
        .values({
          id: newId(),
          titleRelavency: score.titleRelavency,
          titleRelavencyReason: score.titleRelavencyReason,
          ofJobPostId: jobPostId,
        })
        .execute();
    } catch (err) {
      terminal.warn(`JobPost insert failed for ${j.url}: ${String(err)}`);
    }
  }
  return inserted;
}
