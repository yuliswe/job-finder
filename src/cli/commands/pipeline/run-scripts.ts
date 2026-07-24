import { Command, Option } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'jobfinder.config.js';
import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
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
  inScopeForRunScripts,
  qualifiedForRunScripts,
} from 'src/db/pipelineQualified.js';
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

type RunScriptsOptions = {
  division?: string;
  location?: string;
  all?: boolean;
  includeFailed?: boolean;
  jobListSourceId?: string;
  /** Process the selected rows now. Without it the command only queues
   * them for a later `--start` / `jobfinder start-pipeline`. */
  start?: boolean;
  /** Suppress "nothing to do" / "0 rows" logs. See SourcingOptions. */
  suppressNothingToDoLog?: boolean;
};

export function createRunScriptsCommand(): Command {
  return new Command('run-scripts')
    .description(
      'For every JobListSource with a validated parserScript, ask the LLM to map the supplied (or interests-derived) division/location to the page filter options, then run searchJobs and insert the matching jobs into JobPost. By default only queues the selected rows; pass --start to process them now.'
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
        'Re-process every qualifying in-scope JobListSource regardless of pipeline state. Use after a prompt change.'
      )
    )
    .addOption(
      new Option(
        '--include-failed',
        'Also retry rows in failed / aborted / no_result state (default skips them). Mutually exclusive with --all.'
      )
    )
    .option(
      '--job-list-source-id <id>',
      'Re-process only the JobListSource with this ID, regardless of pipeline state or qualification.'
    )
    .option(
      '--start',
      'Process the selected rows now. Without this flag the command only queues them for a later `--start` or `jobfinder start-pipeline`.'
    )
    .action(async (opts: RunScriptsOptions) => {
      if (opts.start) {
        await withBrowserInstance(context => runRunScripts(context, opts));
        return;
      }

      await queueRunScripts(opts);
    });
}

/** Enqueue any explicitly-requested row, apply --all's bulk requeue, and
 * return the rows the mode selects. Shared by the queue-only default path
 * and the --start processing path. */
async function pickRunScriptsTargets(opts: RunScriptsOptions): Promise<
  {
    id: string;
    url: string;
    parserScript: string | null;
    ofJobSourceId: string;
  }[]
> {
  if (opts.jobListSourceId) {
    const exists = await db
      .selectFrom('JobListSource')
      .select('id')
      .where('id', '=', opts.jobListSourceId)
      .executeTakeFirst();

    if (!exists) {
      throw new Error(
        `JobListSource with id ${opts.jobListSourceId} not found.`
      );
    }

    await enqueuePipelineTask({
      task: 'run-scripts',
      entity: { ofJobListSourceId: opts.jobListSourceId },
    });
  }

  const mode = pipelineModeFromOptions(opts);
  if (mode === 'all') await requeueAllInScope('run-scripts');

  // Picker = qualifiedForX ∩ inScopeForX + state filter chosen by mode.
  const stateFilter = pickerStateFilter({
    task: 'run-scripts',
    parentIdRef: 'JobListSource.id',
    mode,
  });

  let query = db
    .selectFrom('JobListSource')
    .select(['id', 'url', 'parserScript', 'ofJobSourceId'])
    .where(qualifiedForRunScripts)
    .where(inScopeForRunScripts);

  if (stateFilter) query = query.where(stateFilter);

  return opts.jobListSourceId
    ? db
        .selectFrom('JobListSource')
        .select(['id', 'url', 'parserScript', 'ofJobSourceId'])
        .where('JobListSource.id', '=', opts.jobListSourceId)
        .execute()
    : query.execute();
}

export async function queueRunScripts(
  opts: RunScriptsOptions
): Promise<{ queued: number }> {
  const mode = pipelineModeFromOptions(opts);
  const targets = await pickRunScriptsTargets(opts);

  // The default mode only selects rows that are already queued, --all
  // bulk-requeues inside the picker, and --job-list-source-id enqueues its
  // row explicitly — so only --include-failed's failed/aborted/no_result
  // rows still need a fresh queued state for a later --start to pick them up.
  if (mode === 'include-failed') {
    for (const target of targets) {
      await enqueuePipelineTask({
        task: 'run-scripts',
        entity: { ofJobListSourceId: target.id },
      });
    }
  }

  terminal.log(
    `${targets.length} JobListSource row(s) queued for run-scripts. Pass --start (or \`jobfinder start-pipeline\`) to process them.`
  );

  return { queued: targets.length };
}

export async function runRunScripts(
  context: BrowserContext,
  opts: RunScriptsOptions
): Promise<{ processed: number }> {
  await reapStaleStartedStates('run-scripts');
  const targets = await pickRunScriptsTargets(opts);

  if (targets.length === 0) {
    if (!opts.suppressNothingToDoLog) {
      terminal.log(
        'No JobListSource rows with a validated parserScript. Nothing to do.'
      );
    }

    return { processed: 0 };
  }

  const interests = await getUserInterests();
  if (!interests) {
    terminal.warn(
      'No user interests found (data/interests.local.md or data/interests.md). Relevance scores will all be neutral (0.5).'
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

  if (jobPostInserted > 0 || !opts.suppressNothingToDoLog) {
    terminal.log(`Inserted ${jobPostInserted} rows into JobPost\n`);
  }

  return { processed: targets.length };
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
      'Both --division and --location must be supplied when interests text is empty (data/interests.local.md / data/interests.md is missing).'
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
