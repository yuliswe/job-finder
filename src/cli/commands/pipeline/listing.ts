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
};

export function createListingCommand(): Command {
  return new Command('listing')
    .description(
      'For each currently-queued JobSource, BFS the company site to find its job-listing page; insert a JobListSource row with a placeholder parserScript (`pipeline scripting` fills it in).'
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
    .action((opts: ListingOptions) =>
      withBrowserInstance(context => runListing(context, opts))
    );
}

async function runListing(
  context: BrowserContext,
  opts: ListingOptions
): Promise<void> {
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
    .where(inScopeForListing);

  if (stateFilter) query = query.where(stateFilter);

  const rawSources = opts.jobSourceId
    ? await db
        .selectFrom('JobSource')
        .select(['id', 'name', 'url'])
        .where('JobSource.id', '=', opts.jobSourceId)
        .execute()
    : await query.execute();

  const sources = rawSources.map(s => {
    if (s.url == null) {
      throw new Error(
        `JobSource ${s.id} (${s.name}) has no url — cannot list.`
      );
    }

    return { id: s.id, name: s.name, url: s.url };
  });

  const results = await Promise.all(
    sources.map(source => tabLimit(() => listOneSource({ context, source })))
  );

  const jobListSourceInserted = results.reduce(
    (sum, r) => sum + (r?.jobListSourceInserted ?? 0),
    0
  );

  terminal.log(`Inserted ${jobListSourceInserted} rows into JobListSource\n`);
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

      const listingUrl = await findJobListPage({ context, startUrl });
      if (!listingUrl) {
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
