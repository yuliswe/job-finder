import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import { terminal } from 'src/utils/terminal.js';

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

/**
 * Run one record's worth of work, bracketed by `started`/`failed` state
 * recording. Per-command files wrap their per-record helpers around this so
 * thrown errors uniformly mark the record failed and skip the trigger.
 *
 * Returns `work`'s result on success, or `undefined` on caught error.
 */
export async function processOne<T>(args: {
  task: PipelineTask;
  entity: PipelineEntity;
  work: () => Promise<T>;
  /** Short label (URL, name, id) included in the error log on failure. */
  label?: string;
}): Promise<T | undefined> {
  await recordPipelineState({
    task: args.task,
    state: 'started',
    entity: args.entity,
  });
  try {
    return await args.work();
  } catch (err) {
    terminal.error(
      `${args.task} failed${args.label ? ` for ${args.label}` : ''}: ${String(err)}`
    );
    await recordPipelineState({
      task: args.task,
      state: 'failed',
      reason: String(err).slice(0, 500),
      entity: args.entity,
    });
    return undefined;
  }
}
