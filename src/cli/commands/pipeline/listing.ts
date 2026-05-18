import { Command } from 'commander';
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
} from 'src/db/pipelineState.js';
import { qualifiedForListing } from 'src/db/pipelineQualified.js';
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
    .where(qualifiedForListing)
    .where(
      eligibleForPipelineTask({
        task: 'listing',
        parentIdRef: 'JobSource.id',
      })
    )
    .execute();

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
