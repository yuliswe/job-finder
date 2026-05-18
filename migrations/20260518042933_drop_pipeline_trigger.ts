import { Kysely, sql } from 'kysely';

import { Bool } from 'src/db/customTypes.js';

// Step 2 of deprecating PipelineTrigger: the work-queue role moved to
// PipelineState (latest row per (task, entity)) and the LatestPipelineState
// view. Nothing reads from PipelineTrigger anymore; drop it.

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('PipelineTrigger').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Best-effort rollback for dev only. Rebuild the table from its original
  // schema (mirrors migrations/20260517232144_add_pipeline_trigger.ts), then
  // backfill from LatestPipelineState: one trigger per (task, entity), with
  // isProcessed=1 iff the latest state is a terminal-success value.
  await db.schema
    .createTable('PipelineTrigger')
    .addColumn('id', 'text', c => c.primaryKey().notNull())
    .addColumn('createdAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('updatedAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('task', 'text', c => c.notNull())
    .addColumn('isProcessed', sql`integer_boolean`, c =>
      c.notNull().defaultTo(Bool.False)
    )
    .addColumn('ofSourceSeedId', 'text', c =>
      c.references('SourceSeed.id').onDelete('cascade')
    )
    .addColumn('ofJobSourceId', 'text', c =>
      c.references('JobSource.id').onDelete('cascade')
    )
    .addColumn('ofJobListSourceId', 'text', c =>
      c.references('JobListSource.id').onDelete('cascade')
    )
    .addColumn('ofJobPostId', 'text', c =>
      c.references('JobPost.id').onDelete('cascade')
    )
    .execute();

  await db.schema
    .createIndex('PipelineTrigger_task_idx')
    .on('PipelineTrigger')
    .column('task')
    .execute();
  await db.schema
    .createIndex('PipelineTrigger_isProcessed_idx')
    .on('PipelineTrigger')
    .column('isProcessed')
    .execute();
  await db.schema
    .createIndex('PipelineTrigger_ofSourceSeedId_idx')
    .on('PipelineTrigger')
    .column('ofSourceSeedId')
    .execute();
  await db.schema
    .createIndex('PipelineTrigger_ofJobSourceId_idx')
    .on('PipelineTrigger')
    .column('ofJobSourceId')
    .execute();
  await db.schema
    .createIndex('PipelineTrigger_ofJobListSourceId_idx')
    .on('PipelineTrigger')
    .column('ofJobListSourceId')
    .execute();
  await db.schema
    .createIndex('PipelineTrigger_ofJobPostId_idx')
    .on('PipelineTrigger')
    .column('ofJobPostId')
    .execute();

  await sql`
    CREATE UNIQUE INDEX PipelineTrigger_task_ofSourceSeedId_uniq
      ON PipelineTrigger (task, ofSourceSeedId)
      WHERE ofSourceSeedId IS NOT NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX PipelineTrigger_task_ofJobSourceId_uniq
      ON PipelineTrigger (task, ofJobSourceId)
      WHERE ofJobSourceId IS NOT NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX PipelineTrigger_task_ofJobListSourceId_uniq
      ON PipelineTrigger (task, ofJobListSourceId)
      WHERE ofJobListSourceId IS NOT NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX PipelineTrigger_task_ofJobPostId_uniq
      ON PipelineTrigger (task, ofJobPostId)
      WHERE ofJobPostId IS NOT NULL
  `.execute(db);

  // Reconstruct one trigger per (task, entity). isProcessed=1 when the latest
  // state is a terminal success ('done', 'success', 'not_a_job_posting');
  // anything else (queued, started, failed, no_*, aborted, …) → 0.
  await sql`
    INSERT INTO PipelineTrigger (id, task, isProcessed,
                                 ofSourceSeedId, ofJobSourceId,
                                 ofJobListSourceId, ofJobPostId,
                                 createdAt, updatedAt)
    SELECT lower(hex(randomblob(16))), task,
           CASE WHEN state IN ('done', 'success', 'not_a_job_posting') THEN 1 ELSE 0 END,
           ofSourceSeedId, ofJobSourceId, ofJobListSourceId, ofJobPostId,
           createdAt, updatedAt
    FROM LatestPipelineState
  `.execute(db);
}
