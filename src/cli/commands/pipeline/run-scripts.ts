import { Command, Option } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'jobfinder.config.js';
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
import { qualifiedForRunScripts } from 'src/db/pipelineQualified.js';
import {
  batchEvaluateJobTitlesRelevancy,
  type JobRelevanceScore,
} from 'src/llm/batchEvaluateJobTitlesRelevancy.js';
import { extractUserFilterPrefs } from 'src/llm/extractUserFilterPrefs.js';
import { runParserScript } from 'src/llm/runParserScript.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';
import { getUserInterests } from 'src/utils/userInterests.js';

const tabLimit = pLimit(MAX_CONCURRENT_BROWSER_TABS);

export function createRunScriptsCommand(): Command {
  return new Command('run-scripts')
    .description(
      'For every JobListSource with a validated parserScript, ask the LLM to map the supplied (or interests-derived) division/location to the page filter options, then run searchJobs and insert the matching jobs into JobPost'
    )
    .option(
      '-d, --division <division>',
      'Division/department to filter by (e.g. "engineering"). Overrides the value extracted from interests.md.'
    )
    .option(
      '-l, --location <location>',
      'Location to filter by (e.g. "Toronto, ON"). Overrides the value extracted from interests.md.'
    )
    .addOption(
      new Option(
        '--all',
        'Re-process every qualifying JobListSource regardless of pipeline state. Useful after a prompt change.'
      )
    )
    .action(
      async (opts: { division?: string; location?: string; all?: boolean }) => {
        await withBrowserInstance(context => runAll(context, opts));
      }
    );
}

async function runAll(
  context: BrowserContext,
  opts: { division?: string; location?: string; all?: boolean }
): Promise<void> {
  if (opts.all) await requeueAllTerminal('run-scripts');

  const targets = await db
    .selectFrom('JobListSource')
    .select(['id', 'url', 'parserScript', 'ofJobSourceId'])
    .where(qualifiedForRunScripts)
    .where(
      eligibleForPipelineTask({
        task: 'run-scripts',
        parentIdRef: 'JobListSource.id',
      })
    )
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

  const { division, location } = await resolveFilterPrefs({
    cliDivision: opts.division,
    cliLocation: opts.location,
    interests,
  });

  terminal.log(`Using division="${division}" location="${location}"`);

  const results = await Promise.all(
    targets.map(target =>
      tabLimit(() =>
        runScriptsForTarget({
          context,
          target,
          args: { division, location },
          interests,
        })
      )
    )
  );

  const jobPostInserted = results.reduce(
    (sum, r) => sum + (r?.jobPostInserted ?? 0),
    0
  );

  terminal.log(`Inserted ${jobPostInserted} rows into JobPost\n`);
}

async function resolveFilterPrefs(args: {
  interests: string;
  cliDivision?: string;
  cliLocation?: string;
}): Promise<{ division: string; location: string }> {
  const { cliDivision, cliLocation, interests } = args;
  if (cliDivision && cliLocation) {
    return { division: cliDivision, location: cliLocation };
  }

  if (!interests) {
    throw new Error(
      'Both --division and --location must be supplied when interests text is empty (seeds/interests.local.md / seeds/interests.md is missing).'
    );
  }

  terminal.log('Extracting division/location from interests via LLM…');
  const extracted = await extractUserFilterPrefs({ interests });
  return {
    division: cliDivision ?? extracted.division,
    location: cliLocation ?? extracted.location,
  };
}

async function runScriptsForTarget(args: {
  context: BrowserContext;
  target: {
    id: string;
    url: string;
    parserScript: string | null;
    ofJobSourceId: string;
  };
  args: { division: string; location: string };
  interests: string;
}): Promise<{ jobPostInserted: number } | undefined> {
  const { context, target, args: opts, interests } = args;
  const { parserScript } = target;
  if (!parserScript) return; // filtered above but TS narrowing

  return processOne({
    task: 'run-scripts',
    entity: { ofJobListSourceId: target.id },
    label: target.url,
    work: async (): Promise<{ jobPostInserted: number }> => {
      terminal.log(`Running parserScript for ${target.url}`);

      const result = await runParserScript({
        context,
        listingUrl: target.url,
        script: parserScript,
        userLocation: opts.location,
        userDivision: opts.division,
      });

      if (!result.ok && result.reason === 'script_error') {
        terminal.error(`script_error for ${target.url}: ${result.error}`);

        await recordPipelineState({
          task: 'run-scripts',
          state: PIPELINE_STATE.SCRIPT_ERROR,
          reason: result.error,
          entity: { ofJobListSourceId: target.id },
        });
        return { jobPostInserted: 0 };
      }

      if (!result.ok && result.reason === 'no_result_found') {
        terminal.warn(
          `no_result_found for ${target.url} (picked ${JSON.stringify(result.picked)})`
        );

        await recordPipelineState({
          task: 'run-scripts',
          state: PIPELINE_STATE.NO_RESULT_FOUND,
          reason: `picked locations=${JSON.stringify(result.picked.locations)} divisions=${JSON.stringify(result.picked.divisions)}`,
          entity: { ofJobListSourceId: target.id },
        });
        return { jobPostInserted: 0 };
      }

      if (!result.ok) {
        throw new Error(
          `Unexpected result from runParserScript: ${JSON.stringify(result)}`
        );
      }

      const scores = await batchEvaluateJobTitlesRelevancy({
        interests,
        candidates: result.jobs,
      });

      const { jobPostInserted } = await insertJobsWithScores({
        jobs: result.jobs,
        scores,
        ofJobSourceId: target.ofJobSourceId,
        ofJobListSourceId: target.id,
      });

      await recordPipelineState({
        task: 'run-scripts',
        state: PIPELINE_STATE.DONE,
        reason: `${jobPostInserted}/${result.jobs.length} new JobPost rows`,
        entity: { ofJobListSourceId: target.id },
      });

      return { jobPostInserted };
    },
  });
}

async function insertJobsWithScores(args: {
  jobs: { jobTitle: string; url: string }[];
  scores: JobRelevanceScore[];
  ofJobSourceId: string;
  ofJobListSourceId: string;
}) {
  const { jobs, scores, ofJobSourceId, ofJobListSourceId } = args;
  const counter = { jobPostInserted: 0 };

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
      if (wasInserted) counter.jobPostInserted++;

      // Resolve the JobPost.id we should hang the eval off of. For brand-new
      // rows it's `newJobId`; for duplicate URLs we look up the existing one.
      let jobPostId: string;
      if (wasInserted) {
        jobPostId = newJobId;

        await enqueuePipelineTask({
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
        .onConflict(oc =>
          oc.column('ofJobPostId').doUpdateSet({
            titleRelavency: score.titleRelavency,
            titleRelavencyReason: score.titleRelavencyReason,
            updatedAt: new Date().toISOString(),
          })
        )
        .execute();
    } catch (err) {
      terminal.warn(`JobPost insert failed for ${j.url}: ${String(err)}`);
    }
  }

  return counter;
}
