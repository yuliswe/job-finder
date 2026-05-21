import { Command, Option } from 'commander';
import pLimit from 'p-limit';

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
  neededForSourcing,
  qualifiedForSourcing,
} from 'src/db/pipelineQualified.js';
import { findCompanyUrl } from 'src/llm/findCompanyUrl.js';
import { terminal } from 'src/utils/terminal.js';

// Sourcing is LLM-only — no browser tabs — but we still bound concurrency to
// avoid hammering the provider with hundreds of simultaneous calls.
const concurrency = pLimit(MAX_CONCURRENT_BROWSER_TABS);

type SourcingOptions = {
  all?: boolean;
  includeFailed?: boolean;
  jobSourceId?: string;
};

export function createSourcingCommand(): Command {
  return new Command('sourcing')
    .description(
      'For every active JobSource with `url IS NULL`, ask the LLM (with web search) for the company URL and fill it in.'
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
    .action((opts: SourcingOptions) => runSourcing(opts));
}

async function runSourcing(opts: SourcingOptions): Promise<void> {
  if (opts.jobSourceId) {
    await enqueuePipelineTask({
      task: 'sourcing',
      entity: { ofJobSourceId: opts.jobSourceId },
    });
  }

  const mode = pipelineModeFromOptions(opts);
  if (mode === 'all') await requeueAllInScope('sourcing');

  // Picker = qualifiedForX ∩ inScopeForX ∩ neededForX + state filter.
  // `neededForSourcing` is the "still needs sourcing" data check (url IS
  // NULL) — rows whose url has already been filled are skipped regardless
  // of mode.
  const stateFilter = pickerStateFilter({
    task: 'sourcing',
    parentIdRef: 'JobSource.id',
    mode,
  });

  let query = db
    .selectFrom('JobSource')
    .select(['id', 'name'])
    .where(qualifiedForSourcing)
    .where(inScopeForSourcing)
    .where(neededForSourcing);

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
    sources.map(source => concurrency(() => sourceOneJobSource({ source })))
  );

  const filled = results.reduce((sum, r) => sum + (r?.urlFilled ?? 0), 0);
  terminal.log(`Filled url on ${filled} JobSource row(s)\n`);
}

async function sourceOneJobSource(args: {
  source: { id: string; name: string };
}): Promise<{ urlFilled: number } | undefined> {
  const { source } = args;
  return processOne({
    task: 'sourcing',
    entity: { ofJobSourceId: source.id },
    label: source.name,
    work: async (): Promise<{ urlFilled: number }> => {
      const url = await findCompanyUrl({ name: source.name });

      if (!url) {
        await recordPipelineState({
          task: 'sourcing',
          state: PIPELINE_STATE.NO_SOURCE_FOUND,
          entity: { ofJobSourceId: source.id },
        });
        return { urlFilled: 0 };
      }

      await db
        .updateTable('JobSource')
        .set({ url })
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
