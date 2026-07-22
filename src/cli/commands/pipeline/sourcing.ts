import { Command, Option } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

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
  previouslyQueuedForSourcing,
  inScopeForSourcing,
  neededForSourcing,
  qualifiedForSourcing,
} from 'src/db/pipelineQualified.js';
import { findCompanyUrl } from 'src/llm/findCompanyUrl.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';
import { getUserInterests } from 'src/utils/userInterests.js';

/** Soft cap on parallel LLM calls so we don't hammer the provider. Browser
 * tab concurrency is independently capped inside `withBrowserTab`. */
const LLM_CONCURRENCY = 10;
const concurrency = pLimit(LLM_CONCURRENCY);

type SourcingOptions = {
  all?: boolean;
  includeFailed?: boolean;
  jobSourceId?: string;
  /** Process the selected rows now. Without it the command only queues
   * them for a later `--start` / `jobfinder start-pipeline`. */
  start?: boolean;
  /** Suppress "nothing to do" / "0 rows" log lines. Set by the
   * start-pipeline orchestrator since its tight poll loop would otherwise
   * spam the terminal. Individual `jobfinder pipeline sourcing` invocations
   * leave it false so the user sees actionable feedback. */
  suppressNothingToDoLog?: boolean;
};

export function createSourcingCommand(): Command {
  return new Command('sourcing')
    .description(
      'For every active JobSource with `url IS NULL`, ask the LLM (with web search) for the company URL, verify it by opening the page, and fill it in. By default only queues the selected rows; pass --start to process them now.'
    )
    .addOption(
      new Option(
        '--all',
        'Re-process every qualifying in-scope JobSource regardless of pipeline state. Use after a prompt change.'
      )
    )
    .addOption(
      new Option(
        '--include-failed',
        'Also retry rows in failed / aborted / no_result state (default skips them). Mutually exclusive with --all.'
      )
    )
    .option(
      '--job-source-id <id>',
      'Re-process only the JobSource with this ID, regardless of pipeline state or qualification.'
    )
    .option(
      '--start',
      'Process the selected rows now. Without this flag the command only queues them for a later `--start` or `jobfinder start-pipeline`.'
    )
    .action(async (opts: SourcingOptions) => {
      if (opts.start) {
        await withBrowserInstance(context => runSourcing(context, opts));
        return;
      }

      await queueSourcing(opts);
    });
}

/** Enqueue any explicitly-requested row, apply --all's bulk requeue, and
 * return the rows the mode selects. Shared by the queue-only default path
 * and the --start processing path. */
async function pickSourcingTargets(
  opts: SourcingOptions
): Promise<{ id: string; name: string; url: string | null }[]> {
  if (opts.jobSourceId) {
    await enqueuePipelineTask({
      task: 'sourcing',
      entity: { ofJobSourceId: opts.jobSourceId },
    });
  }

  const mode = pipelineModeFromOptions(opts);
  if (mode === 'all') await requeueAllInScope('sourcing');

  // Picker = qualifiedForX ∩ inScopeForX [∩ neededForX] + state filter.
  // `--all` deliberately drops `neededForSourcing` so already-complete rows
  // get re-processed (the documented purpose: "re-process every in-scope
  // row, e.g. after a prompt change"). Default and `--include-failed`
  // still apply `neededForSourcing` so rows whose output columns are all
  // filled are skipped.
  const stateFilter = pickerStateFilter({
    task: 'sourcing',
    parentIdRef: 'JobSource.id',
    mode,
  });

  // Picker predicate = (qualified ∧ inScope [∧ needed] [∧ stateFilter])
  //   ∨ (row is currently queued for sourcing).
  // The OR override means anything explicitly enqueued is always processed,
  // even if it now falls outside qualified/scope/needed/state filters.
  const query = db
    .selectFrom('JobSource')
    .select(['id', 'name', 'url'])
    .where(eb =>
      eb.or([
        eb.and([
          qualifiedForSourcing(eb),
          inScopeForSourcing(eb),
          ...(mode !== 'all' ? [neededForSourcing(eb)] : []),
          ...(stateFilter ? [stateFilter(eb)] : []),
        ]),
        previouslyQueuedForSourcing(eb),
      ])
    );

  return opts.jobSourceId
    ? db
        .selectFrom('JobSource')
        .select(['id', 'name', 'url'])
        .where('JobSource.id', '=', opts.jobSourceId)
        .execute()
    : query.execute();
}

export async function queueSourcing(
  opts: SourcingOptions
): Promise<{ queued: number }> {
  const mode = pipelineModeFromOptions(opts);
  const targets = await pickSourcingTargets(opts);

  // The default mode only selects rows that are already queued, --all
  // bulk-requeues inside the picker, and --job-source-id enqueues its row
  // explicitly — so only --include-failed's failed/aborted/no_result rows
  // still need a fresh queued state for a later --start to pick them up.
  if (mode === 'include-failed') {
    for (const target of targets) {
      await enqueuePipelineTask({
        task: 'sourcing',
        entity: { ofJobSourceId: target.id },
      });
    }
  }

  terminal.log(
    `${targets.length} JobSource row(s) queued for sourcing. Pass --start (or \`jobfinder start-pipeline\`) to process them.`
  );

  return { queued: targets.length };
}

export async function runSourcing(
  context: BrowserContext,
  opts: SourcingOptions
): Promise<{ processed: number }> {
  await reapStaleStartedStates('sourcing');
  const sources = await pickSourcingTargets(opts);

  if (sources.length === 0) {
    if (!opts.suppressNothingToDoLog) {
      terminal.log('No JobSource rows need sourcing. Nothing to do.');
    }

    return { processed: 0 };
  }

  // Read interests once up front. Empty is OK — `findCompanyUrl` scores 0.0
  // with an explanatory reason in that case.
  const interests = await getUserInterests();

  const results = await Promise.all(
    sources.map(source =>
      concurrency(() => sourceOneJobSource({ source, interests, context }))
    )
  );

  const filled = results.reduce((sum, r) => sum + (r?.urlFilled ?? 0), 0);
  if (filled > 0 || !opts.suppressNothingToDoLog) {
    terminal.log(`Filled url on ${filled} JobSource row(s)\n`);
  }

  return { processed: sources.length };
}

async function sourceOneJobSource(args: {
  source: { id: string; name: string; url: string | null };
  interests: string;
  context: BrowserContext;
}): Promise<{ urlFilled: number } | undefined> {
  const { source, interests, context } = args;
  return processOne({
    task: 'sourcing',
    entity: { ofJobSourceId: source.id },
    label: source.name,
    work: async (): Promise<{ urlFilled: number }> => {
      // URL discovery + verification all happens inside `findCompanyUrl`:
      // its `validate` opens each candidate URL in the browser and asks a
      // fresh-memory LLM whether the page matches the summary. Mismatches
      // feed back into the same loop so the LLM sees its rejected URLs in
      // conversation history and refines the next search. We always run it
      // — even when `source.url` is already set — so that the picker's
      // selection drives a fresh verify-and-refresh pass.
      const evaluation = await findCompanyUrl({
        name: source.name,
        interests,
        context,
      });

      const evalFields = {
        summary: evaluation.summary,
        interestScore: evaluation.interestScore,
        interestScoreReason: evaluation.interestScoreReason,
      };

      // URL UNIQUE conflict: another JobSource already holds this URL.
      // Drop the current row (its children cascade); the survivor was
      // sourced under its own (correctly-named) call so its data stays
      // canonical.
      const existing = await db
        .selectFrom('JobSource')
        .select('id')
        .where('url', '=', evaluation.url)
        .where('id', '!=', source.id)
        .executeTakeFirst();

      if (existing) {
        await db.deleteFrom('JobSource').where('id', '=', source.id).execute();

        terminal.log(
          `Dropped "${source.name}" — its url ${evaluation.url} is already held by JobSource ${existing.id}.`
        );

        return { urlFilled: 0 };
      }

      await db
        .updateTable('JobSource')
        .set({ url: evaluation.url, ...evalFields })
        .where('id', '=', source.id)
        .execute();

      await recordPipelineState({
        task: 'sourcing',
        state: PIPELINE_STATE.DONE,
        entity: { ofJobSourceId: source.id },
      });

      await enqueuePipelineTask({
        task: 'listing',
        entity: { ofJobSourceId: source.id },
      });

      return { urlFilled: 1 };
    },
  });
}
