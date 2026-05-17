import { Command } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'jobfinder.config.js';
import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import { recordPipelineState } from 'src/db/pipelineState.js';
import { Bool } from 'src/db/customTypes.js';
import {
  enqueueTrigger,
  markTriggerProcessed,
} from 'src/db/pipelineTrigger.js';
import { findJobListPage } from 'src/llm/discoverJobListSource.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';

const tabLimit = pLimit(MAX_CONCURRENT_BROWSER_TABS);

export function createListingCommand(): Command {
  return new Command('listing')
    .description(
      'For each unprocessed JobSource, BFS the company site to find its job-listing page; insert a JobListSource row with a placeholder parserScript (`pipeline scripting` fills it in)'
    )
    .action(async () => {
      await withBrowserInstance(context => runListing(context));
    });
}

async function runListing(context: BrowserContext): Promise<void> {
  const sources = await db
    .selectFrom('JobSource')
    .select(['id', 'name', 'url'])
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('PipelineTrigger')
            .select('PipelineTrigger.id')
            .whereRef('PipelineTrigger.ofJobSourceId', '=', 'JobSource.id')
            .where('PipelineTrigger.task', '=', 'listing')
            .where('PipelineTrigger.isProcessed', '=', Bool.True)
        )
      )
    )
    .execute();

  let inserted = 0;
  await Promise.all(
    sources.map(source =>
      tabLimit(async () => {
        await processSource(context, source);
        inserted++;
      })
    )
  );

  terminal.log(`Inserted ${inserted} rows into JobListSource\n`);
}

async function processSource(
  context: BrowserContext,
  source: { id: string; name: string; url: string }
): Promise<void> {
  terminal.log(`Processing JobSource "${source.name}" (${source.url})`);
  const startUrl = /^https?:\/\//i.test(source.url)
    ? source.url
    : `https://${source.url}`;

  let listingUrl: string | null;
  let failure: string | null = null;
  try {
    listingUrl = await findJobListPage({ context, startUrl });
  } catch (err) {
    terminal.error(`findJobListPage failed for ${source.name}: ${String(err)}`);
    listingUrl = null;
    failure = String(err).slice(0, 500);
  }

  await markTriggerProcessed({
    task: 'listing',
    entity: { ofJobSourceId: source.id },
  });

  if (!listingUrl) {
    terminal.warn(
      `No job-listing page found within depth limit for "${source.name}"`
    );
    await recordPipelineState({
      task: 'listing',
      state: failure ? 'failed' : 'no_listing_found',
      reason: failure,
      entity: { ofJobSourceId: source.id },
    });
    return;
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
    state: 'done',
    reason: wasInserted ? null : 'duplicate JobListSource.url',
    entity: { ofJobSourceId: source.id },
  });
  if (wasInserted) {
    await recordPipelineState({
      task: 'listing',
      state: 'created',
      entity: { ofJobListSourceId: newListId },
    });
    await enqueueTrigger({
      task: 'scripting',
      entity: { ofJobListSourceId: newListId },
    });
  }

  return;
}
