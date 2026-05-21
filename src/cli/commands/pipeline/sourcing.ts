import { Command, Option } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'jobfinder.config.js';
import { db } from 'src/db/index.js';
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
  jobSourceId?: string;
};

export function createSourcingCommand(): Command {
  return new Command('sourcing')
    .description(
      'For each queued URL-less JobSource, BFS the matching SourceSeed URLs to discover the company job-source URL and fill it in.'
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
    .action((opts: SourcingOptions) =>
      withBrowserInstance(context => runSourcing(context, opts))
    );
}

async function runSourcing(
  context: BrowserContext,
  opts: SourcingOptions
): Promise<void> {
  if (opts.jobSourceId) {
    await enqueuePipelineTask({
      task: 'sourcing',
      entity: { ofJobSourceId: opts.jobSourceId },
    });
  }

  const mode = pipelineModeFromOptions(opts);
  if (mode === 'all') await requeueAllInScope('sourcing');

  // Picker = qualifiedForX ∩ inScopeForX + state filter chosen by mode.
  const stateFilter = pickerStateFilter({
    task: 'sourcing',
    parentIdRef: 'JobSource.id',
    mode,
  });

  let query = db
    .selectFrom('JobSource')
    .select(['id', 'name'])
    .where(qualifiedForSourcing)
    .where(inScopeForSourcing);

  if (stateFilter) query = query.where(stateFilter);

  const sources = opts.jobSourceId
    ? await db
        .selectFrom('JobSource')
        .select(['id', 'name'])
        .where('JobSource.id', '=', opts.jobSourceId)
        .execute()
    : await query.execute();

  if (sources.length === 0) {
    terminal.log('No JobSource rows need sourcing. Nothing to do.');
    return;
  }

  const results = await Promise.all(
    sources.map(source =>
      tabLimit(() => sourceOneJobSource({ context, source }))
    )
  );

  const filled = results.reduce((sum, r) => sum + (r?.urlFilled ?? 0), 0);
  terminal.log(`Filled url on ${filled} JobSource row(s)\n`);
}

async function sourceOneJobSource(args: {
  context: BrowserContext;
  source: { id: string; name: string };
}): Promise<{ urlFilled: number } | undefined> {
  const { context, source } = args;
  return processOne({
    task: 'sourcing',
    entity: { ofJobSourceId: source.id },
    label: source.name,
    work: async (): Promise<{ urlFilled: number }> => {
      // The SourceSeed table has the candidate URLs to crawl. Try the most
      // recent ones first; cap retries so a hopeless name doesn't burn the
      // whole budget.
      const seeds = await db
        .selectFrom('SourceSeed')
        .select(['id', 'url'])
        .where('name', '=', source.name)
        .orderBy('createdAt', 'desc')
        .limit(PER_NAME_RETRY_LIMIT)
        .execute();

      if (seeds.length === 0) {
        terminal.warn(
          `No SourceSeed URLs to try for "${source.name}" — leaving JobSource.url null.`
        );

        await recordPipelineState({
          task: 'sourcing',
          state: PIPELINE_STATE.NO_SOURCE_FOUND,
          reason: 'no seed URLs for name',
          entity: { ofJobSourceId: source.id },
        });
        return { urlFilled: 0 };
      }

      for (const seed of seeds) {
        const discovered = await discoverJobSource({
          context,
          url: seed.url,
        });

        if (!discovered) continue;

        await db
          .updateTable('JobSource')
          .set({ url: discovered.url })
          .where('id', '=', source.id)
          .execute();

        await recordPipelineState({
          task: 'sourcing',
          state: PIPELINE_STATE.DONE,
          reason: `via seed ${seed.url}`,
          entity: { ofJobSourceId: source.id },
        });

        await enqueuePipelineTask({
          task: 'listing',
          entity: { ofJobSourceId: source.id },
        });

        return { urlFilled: 1 };
      }

      terminal.warn(
        `discoverJobSource returned no result for "${source.name}" across ${seeds.length} seed URL(s).`
      );

      await recordPipelineState({
        task: 'sourcing',
        state: PIPELINE_STATE.NO_SOURCE_FOUND,
        entity: { ofJobSourceId: source.id },
      });
      return { urlFilled: 0 };
    },
  });
}
