import { Bool } from 'src/db/customTypes.js';
import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';

/** Every pipeline task has a `PipelineTrigger` row per entity it operates on. */
export type TriggerTask =
  | 'seeding'
  | 'sourcing'
  | 'listing'
  | 'scripting'
  | 'run-scripts'
  | 'viewing'
  | 'evaluate';

export type TriggerEntity =
  | { ofSourceSeedId: string }
  | { ofJobSourceId: string }
  | { ofJobListSourceId: string }
  | { ofJobPostId: string };

type TriggerFk =
  | 'ofSourceSeedId'
  | 'ofJobSourceId'
  | 'ofJobListSourceId'
  | 'ofJobPostId';

const FK_BY_TASK: Record<TriggerTask, TriggerFk> = {
  seeding: 'ofSourceSeedId',
  sourcing: 'ofSourceSeedId',
  listing: 'ofJobSourceId',
  scripting: 'ofJobListSourceId',
  'run-scripts': 'ofJobListSourceId',
  viewing: 'ofJobPostId',
  evaluate: 'ofJobPostId',
};

/** Tasks that follow each task in the pipeline. Order:
 *   seeding → sourcing → listing → scripting → run-scripts → viewing → evaluate
 */
export const TASK_ORDER: readonly TriggerTask[] = [
  'seeding',
  'sourcing',
  'listing',
  'scripting',
  'run-scripts',
  'viewing',
  'evaluate',
];

/** Insert a not-yet-processed trigger for (task, entity). Safe to retry — the
 * unique partial indexes on (task, ofXyzId) reject duplicates. */
export async function enqueueTrigger(args: {
  task: TriggerTask;
  entity: TriggerEntity;
}): Promise<void> {
  await db
    .insertInto('PipelineTrigger')
    .values({
      id: newId(),
      task: args.task,
      isProcessed: Bool.False,
      ofSourceSeedId: null,
      ofJobSourceId: null,
      ofJobListSourceId: null,
      ofJobPostId: null,
      ...args.entity,
    })
    .onConflict(oc => oc.doNothing())
    .execute();
}

/** Mark the trigger as processed. Inserts a row if no matching trigger exists
 * yet (defensive against missing enqueue at entity creation time). */
export async function markTriggerProcessed(args: {
  task: TriggerTask;
  entity: TriggerEntity;
}): Promise<void> {
  const fk = FK_BY_TASK[args.task];
  const entityId = entityIdOf(args.entity);
  const result = await db
    .updateTable('PipelineTrigger')
    .set({ isProcessed: Bool.True })
    .where('task', '=', args.task)
    .where(fk, '=', entityId)
    .executeTakeFirst();
  if (Number(result.numUpdatedRows ?? 0) > 0) return;

  await db
    .insertInto('PipelineTrigger')
    .values({
      id: newId(),
      task: args.task,
      isProcessed: Bool.True,
      ofSourceSeedId: null,
      ofJobSourceId: null,
      ofJobListSourceId: null,
      ofJobPostId: null,
      ...args.entity,
    })
    .execute();
}

export async function isTriggerProcessed(args: {
  task: TriggerTask;
  entity: TriggerEntity;
}): Promise<boolean> {
  const fk = FK_BY_TASK[args.task];
  const entityId = entityIdOf(args.entity);
  const row = await db
    .selectFrom('PipelineTrigger')
    .select('id')
    .where('task', '=', args.task)
    .where('isProcessed', '=', Bool.True)
    .where(fk, '=', entityId)
    .executeTakeFirst();
  return row != null;
}

function entityIdOf(entity: TriggerEntity): string {
  if ('ofSourceSeedId' in entity) return entity.ofSourceSeedId;
  if ('ofJobSourceId' in entity) return entity.ofJobSourceId;
  if ('ofJobListSourceId' in entity) return entity.ofJobListSourceId;
  return entity.ofJobPostId;
}
