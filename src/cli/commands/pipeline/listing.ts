import { Command, Option } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'src/utils/config.js';
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
  inScopeForListing,
  qualifiedForListing,
} from 'src/db/pipelineQualified.js';
import { findJobListPage } from 'src/llm/discoverJobListSource.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';

const tabLimit = pLimit(MAX_CONCURRENT_BROWSER_TABS);

type ListingOptions = {
  all?: boolean;
  includeFailed?: boolean;
  jobSourceId?: string;
  /** Process the selected rows now. Without it the command only queues
   * them for a later `--start` / `jobfinder start-pipeline`. */
  start?: boolean;
  /** Suppress "nothing to do" / "0 rows" log lines. See SourcingOptions. */
  suppressNothingToDoLog?: boolean;
};

export function createListingCommand(): Command {
  return new Command('listing')
    .description(
      'For each currently-queued JobSource, BFS the company site to find its job-listing page; insert a JobListSource row with a placeholder parserScript (`pipeline scripting` fills it in). By default only queues the selected rows; pass --start to process them now.'
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
    .action(async (opts: ListingOptions) => {
      if (opts.start) {
        await withBrowserInstance(context => runListing(context, opts));
        return;
      }

      await queueListing(opts);
    });
}

/** Enqueue any explicitly-requested row, apply --all's bulk requeue, and
 * return the rows the mode selects. Shared by the queue-only default path
 * and the --start processing path. */
async function pickListingTargets(
  opts: ListingOptions
): Promise<{ id: string; name: string; url: string }[]> {
  if (opts.jobSourceId) {
    const exists = await db
      .selectFrom('JobSource')
      .select('id')
      .where('id', '=', opts.jobSourceId)
      .executeTakeFirst();

    if (!exists) {
      throw new Error(`JobSource with id ${opts.jobSourceId} not found.`);
    }

    await enqueuePipelineTask({
      task: 'listing',
      entity: { ofJobSourceId: opts.jobSourceId },
    });
  }

  const mode = pipelineModeFromOptions(opts);
  if (mode === 'all') await requeueAllInScope('listing');

  // Picker = qualifiedForX ∩ inScopeForX + state filter chosen by mode.
  const stateFilter = pickerStateFilter({
    task: 'listing',
    parentIdRef: 'JobSource.id',
    mode,
  });

  let query = db
    .selectFrom('JobSource')
    .select(['id', 'name', 'url'])
    .where(qualifiedForListing)
    .where(inScopeForListing)
    // Hold listing while a fresh sourcing is still pending on the same source,
    // so we never crawl a stale url/interestScore that sourcing is about to
    // overwrite. Applied in every mode (correctness, not a state filter); the
    // explicit --job-source-id branch below bypasses it as a manual override.
    .where(
      parentsSettledForPipelineTask({
        task: 'listing',
        parentIdRef: 'JobSource.id',
      })
    );

  if (stateFilter) query = query.where(stateFilter);

  const rawSources = opts.jobSourceId
    ? await db
        .selectFrom('JobSource')
        .select(['id', 'name', 'url'])
        .where('JobSource.id', '=', opts.jobSourceId)
        .execute()
    : await query.execute();

  return rawSources.map(s => {
    if (s.url == null) {
      throw new Error(
        `JobSource ${s.id} (${s.name}) has no url — cannot list.`
      );
    }

    return { id: s.id, name: s.name, url: s.url };
  });
}

export async function queueListing(
  opts: ListingOptions
): Promise<{ queued: number }> {
  const mode = pipelineModeFromOptions(opts);
  const targets = await pickListingTargets(opts);

  // The default mode only selects rows that are already queued, --all
  // bulk-requeues inside the picker, and --job-source-id enqueues its row
  // explicitly — so only --include-failed's failed/aborted/no_result rows
  // still need a fresh queued state for a later --start to pick them up.
  if (mode === 'include-failed') {
    for (const target of targets) {
      await enqueuePipelineTask({
        task: 'listing',
        entity: { ofJobSourceId: target.id },
      });
    }
  }

  terminal.log(
    `${targets.length} JobSource row(s) queued for listing. Pass --start (or \`jobfinder start-pipeline\`) to process them.`
  );

  return { queued: targets.length };
}

export async function runListing(
  context: BrowserContext,
  opts: ListingOptions
): Promise<{ processed: number }> {
  await reapStaleStartedStates('listing');
  const sources = await pickListingTargets(opts);

  const results = await Promise.all(
    sources.map(source => tabLimit(() => listOneSource({ context, source })))
  );

  const jobListSourceInserted = results.reduce(
    (sum, r) => sum + (r?.jobListSourceInserted ?? 0),
    0
  );

  if (jobListSourceInserted > 0 || !opts.suppressNothingToDoLog) {
    terminal.log(`Inserted ${jobListSourceInserted} rows into JobListSource\n`);
  }

  return { processed: sources.length };
}

async function listOneSource(args: {
  context: BrowserContext;
  source: { id: string; name: string; url: string };
}): Promise<{ jobListSourceInserted: number } | undefined> {
  const { context, source } = args;
  return processOne({
    task: 'listing',
    entity: { ofJobSourceId: source.id },
    label: source.name,
    work: async (): Promise<{ jobListSourceInserted: number }> => {
      terminal.log(`Processing JobSource "${source.name}" (${source.url})`);
      const startUrl = /^https?:\/\//i.test(source.url)
        ? source.url
        : `https://${source.url}`;

      const outcome = await findJobListPage({ context, startUrl });

      if (outcome.kind === 'aborted') {
        // Persist the LLM's reason on JobSource so the TUI / future runs can
        // see WHY this source was abandoned (the BFS won't be re-attempted
        // unless --include-failed / --all are passed). The reason string
        // here is the LLM-generated `abortReason` field, never hardcoded.
        await db
          .updateTable('JobSource')
          .set({ abortListingReason: outcome.reason })
          .where('id', '=', source.id)
          .execute();

        terminal.warn(
          `Listing aborted by LLM for "${source.name}": ${outcome.reason}`
        );

        await recordPipelineState({
          task: 'listing',
          state: PIPELINE_STATE.NO_LISTING_FOUND,
          reason: `LLM aborted: ${outcome.reason}`,
          entity: { ofJobSourceId: source.id },
        });
        return { jobListSourceInserted: 0 };
      }

      if (outcome.kind === 'not_found') {
        terminal.warn(
          `No job-listing page found within depth limit for "${source.name}"`
        );

        await recordPipelineState({
          task: 'listing',
          state: PIPELINE_STATE.NO_LISTING_FOUND,
          entity: { ofJobSourceId: source.id },
        });
        return { jobListSourceInserted: 0 };
      }

      const listingUrl = outcome.url;
      const newListId = newId();
      const result = await db
        .insertInto('JobListSource')
        .values({
          id: newListId,
          url: listingUrl,
          parserScript: null,
          ofJobSourceId: source.id,
        })
        .onConflict(oc => oc.column('url').doNothing())
        .executeTakeFirstOrThrow();

      const wasInserted = (result.numInsertedOrUpdatedRows ?? 0n) > 0n;

      await recordPipelineState({
        task: 'listing',
        state: PIPELINE_STATE.DONE,
        reason: wasInserted ? 'inserted' : 'updated',
        entity: { ofJobSourceId: source.id },
      });

      if (wasInserted) {
        await enqueuePipelineTask({
          task: 'scripting',
          entity: { ofJobListSourceId: newListId },
        });
      }

      return { jobListSourceInserted: wasInserted ? 1 : 0 };
    },
  });
}
