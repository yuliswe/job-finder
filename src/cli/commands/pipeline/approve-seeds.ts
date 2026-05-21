import { Command } from 'commander';

import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import { enqueuePipelineTask } from 'src/db/pipelineState.js';
import { terminal } from 'src/utils/terminal.js';

export function createApproveSeedsCommand(): Command {
  return new Command('approve-seeds')
    .description(
      'For each SourceSeed name without a matching JobSource, create a JobSource (url left null) and queue sourcing on it. Run `pipeline sourcing` afterwards to discover the URLs.'
    )
    .action(() => approveSeeds());
}

async function approveSeeds(): Promise<void> {
  // SourceSeed names with no corresponding JobSource yet — these are the ones
  // approval promotes. SourceSeed.name and JobSource.name are both UNIQUE,
  // so this is a simple anti-join.
  const seedNames = await db
    .selectFrom('SourceSeed')
    .leftJoin('JobSource', 'JobSource.name', 'SourceSeed.name')
    .where('JobSource.id', 'is', null)
    .select('SourceSeed.name as name')
    .execute();

  for (const { name } of seedNames) {
    await db
      .insertInto('JobSource')
      .values({ id: newId(), name })
      .onConflict(oc => oc.doNothing())
      .execute();
  }

  // Queue sourcing on every JobSource that still has no URL and no sourcing
  // pipeline state yet. Covers the rows just inserted above PLUS any leftover
  // null-url JobSources from earlier runs that never made it onto the queue.
  const pendingSources = await db
    .selectFrom('JobSource')
    .leftJoin('LatestPipelineState', join =>
      join
        .onRef('LatestPipelineState.ofJobSourceId', '=', 'JobSource.id')
        .on('LatestPipelineState.task', '=', 'sourcing')
    )
    .where('JobSource.url', 'is', null)
    .where('LatestPipelineState.id', 'is', null)
    .select('JobSource.id as id')
    .execute();

  for (const { id } of pendingSources) {
    await enqueuePipelineTask({
      task: 'sourcing',
      entity: { ofJobSourceId: id },
    });
  }

  if (pendingSources.length === 0) {
    terminal.log(
      'No new JobSource rows to approve. Run `pipeline seeding` first.'
    );
    return;
  }

  terminal.log(
    `Queued sourcing for ${pendingSources.length} JobSource(s). Run \`jobfinder pipeline sourcing\` to process them.`
  );
}
