import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';

export type PipelineEntity =
  | { ofSourceSeedId: string }
  | { ofJobSourceId: string }
  | { ofJobListSourceId: string }
  | { ofJobPostId: string };

export type PipelineTask =
  | 'seeding'
  | 'sourcing'
  | 'listing'
  | 'scripting'
  | 'run-scripts'
  | 'viewing'
  | 'evaluate';

/**
 * Append a row to `PipelineState` recording that `task` touched `entity` and
 * left it in `state`. The latest row per (task, entity) — found via
 * `ORDER BY createdAt DESC LIMIT 1` — is the current status.
 */
export async function recordPipelineState(args: {
  task: PipelineTask;
  state: string;
  entity: PipelineEntity;
  reason?: string | null;
}): Promise<void> {
  await db
    .insertInto('PipelineState')
    .values({
      id: newId(),
      task: args.task,
      state: args.state,
      reason: args.reason ?? null,
      ofSourceSeedId: null,
      ofJobSourceId: null,
      ofJobListSourceId: null,
      ofJobPostId: null,
      ...args.entity,
    })
    .execute();
}
