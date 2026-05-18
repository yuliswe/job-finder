import { Kysely, sql } from 'kysely';

// Step 1 of deprecating PipelineTrigger: introduce a LatestPipelineState view
// (latest PipelineState row per (task, entity)) and add a 'queued' state so
// PipelineState can serve as the work queue. PipelineTrigger is left intact;
// a follow-up migration drops it once all code has migrated off.

export async function up(db: Kysely<unknown>): Promise<void> {
  // Composite indexes that cover the view's per-entity ORDER BY and the
  // common "find latest for (task, entity)" lookup pattern. SQLite indexes
  // are scanned forward or backward, so DESC isn't required.
  await db.schema
    .createIndex('PipelineState_task_ofSourceSeedId_createdAt_idx')
    .on('PipelineState')
    .columns(['task', 'ofSourceSeedId', 'createdAt'])
    .execute();
  await db.schema
    .createIndex('PipelineState_task_ofJobSourceId_createdAt_idx')
    .on('PipelineState')
    .columns(['task', 'ofJobSourceId', 'createdAt'])
    .execute();
  await db.schema
    .createIndex('PipelineState_task_ofJobListSourceId_createdAt_idx')
    .on('PipelineState')
    .columns(['task', 'ofJobListSourceId', 'createdAt'])
    .execute();
  await db.schema
    .createIndex('PipelineState_task_ofJobPostId_createdAt_idx')
    .on('PipelineState')
    .columns(['task', 'ofJobPostId', 'createdAt'])
    .execute();

  // Latest row per (task, entity). Exactly one of the four FK columns is set
  // per PipelineState row, so partitioning by all four is equivalent to
  // partitioning by (task, the-one-non-null-fk). Ties broken by id so the
  // result is deterministic when two rows share createdAt.
  await db.schema
    .createView('LatestPipelineState')
    .as(
      sql<unknown>`
        SELECT id, task, state, reason,
               ofSourceSeedId, ofJobSourceId, ofJobListSourceId, ofJobPostId,
               createdAt, updatedAt
        FROM (
          SELECT ps.*,
            ROW_NUMBER() OVER (
              PARTITION BY ps.task,
                           ps.ofSourceSeedId, ps.ofJobSourceId,
                           ps.ofJobListSourceId, ps.ofJobPostId
              ORDER BY ps.createdAt DESC, ps.id DESC
            ) AS rn
          FROM PipelineState ps
        )
        WHERE rn = 1
      `
    )
    .execute();

  // Backfill: every unprocessed trigger becomes a 'queued' PipelineState row.
  // Reuse the trigger's createdAt so any newer terminal state row already in
  // PipelineState still wins under the latest-row-by-(createdAt,id) ordering.
  await sql`
    INSERT INTO PipelineState (id, task, state, ofSourceSeedId, ofJobSourceId,
                               ofJobListSourceId, ofJobPostId, createdAt, updatedAt)
    SELECT lower(hex(randomblob(16))), task, 'queued',
           ofSourceSeedId, ofJobSourceId, ofJobListSourceId, ofJobPostId,
           createdAt, updatedAt
    FROM PipelineTrigger
    WHERE isProcessed = 0
  `.execute(db);

  // Defensive: for triggers marked isProcessed=1 that somehow have no
  // PipelineState row at all (pre-PipelineState data, or trigger-only paths),
  // insert a 'done' row so the view's latest state for that entity is sensible.
  await sql`
    INSERT INTO PipelineState (id, task, state, ofSourceSeedId, ofJobSourceId,
                               ofJobListSourceId, ofJobPostId, createdAt, updatedAt)
    SELECT lower(hex(randomblob(16))), pt.task, 'done',
           pt.ofSourceSeedId, pt.ofJobSourceId,
           pt.ofJobListSourceId, pt.ofJobPostId,
           pt.createdAt, pt.updatedAt
    FROM PipelineTrigger pt
    WHERE pt.isProcessed = 1
      AND NOT EXISTS (
        SELECT 1 FROM PipelineState ps
        WHERE ps.task = pt.task
          AND ((pt.ofSourceSeedId IS NOT NULL AND ps.ofSourceSeedId = pt.ofSourceSeedId)
            OR (pt.ofJobSourceId IS NOT NULL AND ps.ofJobSourceId = pt.ofJobSourceId)
            OR (pt.ofJobListSourceId IS NOT NULL AND ps.ofJobListSourceId = pt.ofJobListSourceId)
            OR (pt.ofJobPostId IS NOT NULL AND ps.ofJobPostId = pt.ofJobPostId))
      )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropView('LatestPipelineState').execute();
  await db.schema
    .dropIndex('PipelineState_task_ofJobPostId_createdAt_idx')
    .execute();
  await db.schema
    .dropIndex('PipelineState_task_ofJobListSourceId_createdAt_idx')
    .execute();
  await db.schema
    .dropIndex('PipelineState_task_ofJobSourceId_createdAt_idx')
    .execute();
  await db.schema
    .dropIndex('PipelineState_task_ofSourceSeedId_createdAt_idx')
    .execute();
  // Backfilled rows are left in PipelineState — harmless (latest-state queries
  // still work, just with extra 'queued' history).
}
