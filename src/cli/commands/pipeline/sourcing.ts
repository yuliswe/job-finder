import { Command } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'jobfinder.config.js';
import { Bool } from 'src/db/customTypes.js';
import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import { recordPipelineState } from 'src/db/pipelineState.js';
import { discoverJobSource } from 'src/llm/discoverJobSource.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';

const PER_NAME_RETRY_LIMIT = 3;
const tabLimit = pLimit(MAX_CONCURRENT_BROWSER_TABS);

export function createSourcingCommand(): Command {
  return new Command('sourcing')
    .description(
      'Discover JobSource rows from recent SourceSeed URLs via headless browse + LLM'
    )
    .action(async () => {
      await withBrowserInstance(context => runSourcing(context));
    });
}

async function runSourcing(context: BrowserContext): Promise<void> {
  const names = await db
    .selectFrom('SourceSeed')
    .select('name')
    .where('isProcessed', '=', Bool.False)
    .distinct()
    .execute();

  if (names.length === 0) {
    terminal.log('All seeds have been processed already. Nothing to do.');
    return;
  }

  let inserted = 0;
  await Promise.all(
    names.map(({ name }) =>
      tabLimit(async () => {
        inserted += await processNameGroup(context, name);
      })
    )
  );

  terminal.log(`Inserted ${inserted} rows into JobSource\n`);
}

async function processNameGroup(
  context: BrowserContext,
  name: string
): Promise<number> {
  terminal.log(`Processing for "${name}"...`);

  const seeds = await db
    .selectFrom('SourceSeed')
    .select(['id', 'url'])
    .where('name', '=', name)
    .where('isProcessed', '=', Bool.False)
    .orderBy('createdAt', 'desc')
    .limit(PER_NAME_RETRY_LIMIT)
    .execute();

  let inserted = 0;
  let groupSucceeded = false;
  for (const { id: seedId, url } of seeds) {
    try {
      const source = await discoverJobSource({ context, url });
      if (!source) {
        terminal.warn(`discoverJobSource returned no result for ${url}`);
        await recordPipelineState({
          task: 'sourcing',
          state: 'no_source_found',
          entity: { ofSourceSeedId: seedId },
        });
        continue;
      }

      const newSourceId = newId();
      const result = await db
        .insertInto('JobSource')
        .values({
          id: newSourceId,
          name: source.name,
          url: source.url,
        })
        .onConflict(oc => oc.column('url').doNothing())
        .executeTakeFirst();

      const wasInserted = (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
      if (wasInserted) inserted++;

      await recordPipelineState({
        task: 'sourcing',
        state: 'done',
        reason: wasInserted ? null : 'duplicate JobSource.url',
        entity: { ofSourceSeedId: seedId },
      });
      if (wasInserted) {
        await recordPipelineState({
          task: 'sourcing',
          state: 'created',
          entity: { ofJobSourceId: newSourceId },
        });
      }

      // if succeeds, we skip other URLs in this group
      groupSucceeded = true;
      break;
    } catch (err) {
      terminal.error(`discoverJobSource failed for ${url}: ${String(err)}`);
      await recordPipelineState({
        task: 'sourcing',
        state: 'failed',
        reason: String(err).slice(0, 500),
        entity: { ofSourceSeedId: seedId },
      });
    }
  }

  if (groupSucceeded) {
    // Mark every row in this name group processed — one win covers the rest.
    await db
      .updateTable('SourceSeed')
      .set({ isProcessed: Bool.True })
      .where('name', '=', name)
      .execute();
  }

  return inserted;
}
