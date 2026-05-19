import { Command } from 'commander';

import { db } from 'src/db/index.js';
import { enqueuePipelineTask } from 'src/db/pipelineState.js';
import { terminal } from 'src/utils/terminal.js';

export function createApproveSeedsCommand(): Command {
  return new Command('approve-seeds')
    .description(
      'Queue sourcing for every SourceSeed that has not yet been approved. Run `pipeline sourcing` afterwards to process the queue.'
    )
    .action(() => approveSeeds());
}

async function approveSeeds(): Promise<void> {
  const rows = await db
    .selectFrom('SourceSeed')
    .leftJoin('LatestPipelineState', join =>
      join
        .onRef('LatestPipelineState.ofSourceSeedId', '=', 'SourceSeed.id')
        .on('LatestPipelineState.task', '=', 'sourcing')
    )
    .select('SourceSeed.id as id')
    .where('LatestPipelineState.id', 'is', null)
    .execute();

  if (rows.length === 0) {
    terminal.log(
      'No new SourceSeed rows to approve. Run `pipeline seeding` first.'
    );
    return;
  }

  for (const r of rows) {
    await enqueuePipelineTask({
      task: 'sourcing',
      entity: { ofSourceSeedId: r.id },
    });
  }

  terminal.log(
    `Queued sourcing for ${rows.length} seed(s). Run \`jobfinder pipeline sourcing\` to process them.`
  );
}
