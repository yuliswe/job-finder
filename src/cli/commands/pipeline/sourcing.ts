import { Command, Option } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'jobfinder.config.js';
import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import {
  enqueuePipelineTask,
  type PipelineMode,
  PIPELINE_STATE,
  pickerStateFilter,
  pipelineModeFromOptions,
  processOne,
  recordPipelineState,
  requeueAllInScope,
} from 'src/db/pipelineState.js';
import {
  inScopeForSourcing,
  qualifiedForSourcing,
} from 'src/db/pipelineQualified.js';
import { discoverJobSource } from 'src/llm/discoverJobSource.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';

const PER_NAME_RETRY_LIMIT = 3;
const tabLimit = pLimit(MAX_CONCURRENT_BROWSER_TABS);

type SourcingOptions = {
  all?: boolean;
  includeFailed?: boolean;
  sourceSeedId?: string;
};

export function createSourcingCommand(): Command {
  return new Command('sourcing')
    .description(
      'Discover JobSource rows from currently-queued SourceSeed URLs via headless browse + LLM.'
    )
    .addOption(
      new Option(
        '--all',
        'Re-process every qualifying in-scope SourceSeed regardless of pipeline state. Use after a prompt change.'
      )
    )
    .addOption(
      new Option(
        '--include-failed',
        'Also retry rows in failed / aborted / no_result state (default skips them). Mutually exclusive with --all.'
      )
    )
    .option(
      '--source-seed-id <id>',
      'Re-process only the SourceSeed with this ID, regardless of pipeline state or qualification. Bypasses the per-company name grouping.'
    )
    .action((opts: SourcingOptions) =>
      withBrowserInstance(context => runSourcing(context, opts))
    );
}

async function runSourcing(
  context: BrowserContext,
  opts: SourcingOptions
): Promise<void> {
  if (opts.sourceSeedId) {
    await runSourcingForOneSeed(context, opts.sourceSeedId);
    return;
  }

  const mode = pipelineModeFromOptions(opts);
  if (mode === 'all') await requeueAllInScope('sourcing');

  // Picker = qualifiedForX ∩ inScopeForX + state filter chosen by mode.
  // For sourcing, both qualified and inScope are trivially true — the
  // state filter does all the work.
  const stateFilter = pickerStateFilter({
    task: 'sourcing',
    parentIdRef: 'SourceSeed.id',
    mode,
  });

  let namesQuery = db
    .selectFrom('SourceSeed')
    .select('name')
    .where(qualifiedForSourcing)
    .where(inScopeForSourcing);

  if (stateFilter) namesQuery = namesQuery.where(stateFilter);
  const names = await namesQuery.distinct().execute();

  if (names.length === 0) {
    terminal.log('All seeds have been processed already. Nothing to do.');
    return;
  }

  const results = await Promise.all(
    names.map(({ name }) =>
      tabLimit(() => sourceOneGroup({ context, name, mode }))
    )
  );

  const jobSourceInserted = results.reduce(
    (sum, r) => sum + r.jobSourceInserted,
    0
  );

  terminal.log(`Inserted ${jobSourceInserted} rows into JobSource\n`);
}

async function runSourcingForOneSeed(
  context: BrowserContext,
  sourceSeedId: string
): Promise<void> {
  const seed = await db
    .selectFrom('SourceSeed')
    .select(['id', 'url'])
    .where('id', '=', sourceSeedId)
    .executeTakeFirst();

  if (!seed) {
    throw new Error(`SourceSeed with id ${sourceSeedId} not found.`);
  }

  await enqueuePipelineTask({
    task: 'sourcing',
    entity: { ofSourceSeedId: sourceSeedId },
  });

  const result = await sourceOneSeedUrl({ context, seed });
  const jobSourceInserted = result?.jobSourceInserted ?? 0;
  terminal.log(`Inserted ${jobSourceInserted} rows into JobSource\n`);
}

async function sourceOneGroup(args: {
  context: BrowserContext;
  name: string;
  mode: PipelineMode;
}): Promise<{ jobSourceInserted: number }> {
  const { context, name, mode } = args;
  terminal.log(`Processing for "${name}"...`);

  // Same state-filter mode as the names query above.
  const stateFilter = pickerStateFilter({
    task: 'sourcing',
    parentIdRef: 'SourceSeed.id',
    mode,
  });

  let seedsQuery = db
    .selectFrom('SourceSeed')
    .select(['id', 'url'])
    .where('name', '=', name)
    .where(qualifiedForSourcing)
    .where(inScopeForSourcing);

  if (stateFilter) seedsQuery = seedsQuery.where(stateFilter);

  const seeds = await seedsQuery
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
    // Mark every row in this name group done — one win covers the rest.
    // sourceOneSeedUrl already recorded 'done' for the winning seed.
    const groupSeeds = await db
      .selectFrom('SourceSeed')
      .select('id')
      .where('name', '=', name)
      .execute();

    for (const seed of groupSeeds) {
      await recordPipelineState({
        task: 'sourcing',
        state: PIPELINE_STATE.DONE,
        reason: 'covered by sibling seed in name group',
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
          state: PIPELINE_STATE.NO_SOURCE_FOUND,
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
        state: PIPELINE_STATE.DONE,
        reason: wasInserted ? 'inserted' : 'updated',
        entity: { ofSourceSeedId: seed.id },
      });

      if (wasInserted) {
        await enqueuePipelineTask({
          task: 'listing',
          entity: { ofJobSourceId: newSourceId },
        });
      }

      return { jobSourceInserted: wasInserted ? 1 : 0 };
    },
  });
}
