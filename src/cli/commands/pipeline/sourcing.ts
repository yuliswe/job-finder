import { Command } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'jobfinder.config.js';
import { Bool } from 'src/db/customTypes.js';
import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import { processOne, recordPipelineState } from 'src/db/pipelineState.js';
import {
  enqueueTrigger,
  markTriggerProcessed,
} from 'src/db/pipelineTrigger.js';
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
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('PipelineTrigger')
            .select('PipelineTrigger.id')
            .whereRef('PipelineTrigger.ofSourceSeedId', '=', 'SourceSeed.id')
            .where('PipelineTrigger.task', '=', 'sourcing')
            .where('PipelineTrigger.isProcessed', '=', Bool.True)
        )
      )
    )
    .distinct()
    .execute();

  if (names.length === 0) {
    terminal.log('All seeds have been processed already. Nothing to do.');
    return;
  }

  const results = await Promise.all(
    names.map(({ name }) => tabLimit(() => sourceOneGroup({ context, name })))
  );
  const jobSourceInserted = results.reduce(
    (sum, r) => sum + r.jobSourceInserted,
    0
  );

  terminal.log(`Inserted ${jobSourceInserted} rows into JobSource\n`);
}

async function sourceOneGroup(args: {
  context: BrowserContext;
  name: string;
}): Promise<{ jobSourceInserted: number }> {
  const { context, name } = args;
  terminal.log(`Processing for "${name}"...`);

  const seeds = await db
    .selectFrom('SourceSeed')
    .select(['id', 'url'])
    .where('name', '=', name)
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('PipelineTrigger')
            .select('PipelineTrigger.id')
            .whereRef('PipelineTrigger.ofSourceSeedId', '=', 'SourceSeed.id')
            .where('PipelineTrigger.task', '=', 'sourcing')
            .where('PipelineTrigger.isProcessed', '=', Bool.True)
        )
      )
    )
    .orderBy('createdAt', 'desc')
    .limit(PER_NAME_RETRY_LIMIT)
    .execute();

  // Try seeds in order; stop as soon as one yields a JobSource.
  // sourceOneSeedUrl never throws — processOne catches and records.
  let jobSourceInserted = 0;
  for (const seed of seeds) {
    const result = await sourceOneSeedUrl({ context, seed });
    if (result && result.jobSourceInserted > 0) {
      jobSourceInserted += result.jobSourceInserted;
      break;
    }
  }

  if (jobSourceInserted > 0) {
    // Mark every row in this name group processed — one win covers the rest.
    const groupSeeds = await db
      .selectFrom('SourceSeed')
      .select('id')
      .where('name', '=', name)
      .execute();
    for (const seed of groupSeeds) {
      await markTriggerProcessed({
        task: 'sourcing',
        entity: { ofSourceSeedId: seed.id },
      });
    }
  }

  return { jobSourceInserted };
}

async function sourceOneSeedUrl(args: {
  context: BrowserContext;
  seed: { id: string; url: string };
}): Promise<{ jobSourceInserted: number } | undefined> {
  const { context, seed } = args;
  return processOne({
    task: 'sourcing',
    entity: { ofSourceSeedId: seed.id },
    label: seed.url,
    work: async (): Promise<{ jobSourceInserted: number }> => {
      const source = await discoverJobSource({ context, url: seed.url });
      if (!source) {
        terminal.warn(`discoverJobSource returned no result for ${seed.url}`);
        await recordPipelineState({
          task: 'sourcing',
          state: 'no_source_found',
          entity: { ofSourceSeedId: seed.id },
        });
        return { jobSourceInserted: 0 };
      }

      const newSourceId = newId();
      const insertResult = await db
        .insertInto('JobSource')
        .values({
          id: newSourceId,
          name: source.name,
          url: source.url,
        })
        .onConflict(oc => oc.column('url').doNothing())
        .executeTakeFirst();
      const wasInserted = (insertResult.numInsertedOrUpdatedRows ?? 0n) > 0n;

      await recordPipelineState({
        task: 'sourcing',
        state: 'done',
        reason: wasInserted ? null : 'duplicate JobSource.url',
        entity: { ofSourceSeedId: seed.id },
      });
      if (wasInserted) {
        await recordPipelineState({
          task: 'sourcing',
          state: 'created',
          entity: { ofJobSourceId: newSourceId },
        });
        await enqueueTrigger({
          task: 'listing',
          entity: { ofJobSourceId: newSourceId },
        });
      }
      return { jobSourceInserted: wasInserted ? 1 : 0 };
    },
  });
}
