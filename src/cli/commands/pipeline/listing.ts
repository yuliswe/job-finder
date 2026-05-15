import { Command } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'jobfinder.config.js';
import { Bool } from 'src/db/customTypes.js';
import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
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
    .where('isProcessed', '=', Bool.False)
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
  try {
    listingUrl = await findJobListPage({ context, startUrl });
  } catch (err) {
    terminal.error(`findJobListPage failed for ${source.name}: ${String(err)}`);
    listingUrl = null;
  }

  await db
    .updateTable('JobSource')
    .set({ isProcessed: Bool.True })
    .where('id', '=', source.id)
    .execute();

  if (!listingUrl) {
    terminal.warn(
      `No job-listing page found within depth limit for "${source.name}"`
    );
    return;
  }

  await db
    .insertInto('JobListSource')
    .values({
      id: newId(),
      url: listingUrl,
      parserScript: null,
      ofJobSourceId: source.id,
    })
    .onConflict(oc => oc.column('url').doNothing())
    .executeTakeFirstOrThrow();

  return;
}
