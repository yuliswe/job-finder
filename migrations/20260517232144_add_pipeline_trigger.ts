import { Kysely, sql } from 'kysely';

import { Bool } from 'src/db/customTypes.js';

export async function up(db: Kysely<unknown>): Promise<void> {
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

  // One trigger per (task, entity). Partial because at most one of the four
  // FK columns is set on any given row.
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

  // Backfill follows the "enqueue only when parent succeeded" rule: a trigger
  // for task X exists for an entity only if the X-1 stage completed for it.
  // ids are random hex; runtime uses uuidv7 but any unique text works here.
  //
  //   seeding     → every SourceSeed (no parent), always isProcessed=1
  //   sourcing    → every SourceSeed (seeding is auto-done), isProcessed = old SourceSeed.isProcessed
  //   listing     → every JobSource (its sourcing succeeded ⇒ row exists), isProcessed = old JobSource.isProcessed
  //   scripting   → every JobListSource (its listing succeeded ⇒ row exists), isProcessed = parserScript IS NOT NULL
  //   run-scripts → JobListSource where parserScript IS NOT NULL (scripting succeeded), isProcessed = old JobListSource.isProcessed
  //   viewing     → every JobPost (its run-scripts succeeded ⇒ row exists), isProcessed = old JobPost.isProcessed
  //   evaluate    → JobPost where old isProcessed=1 (viewing succeeded), isProcessed = JobPostEval has skillScore not null
  await sql`
    INSERT INTO PipelineTrigger (id, task, isProcessed, ofSourceSeedId)
    SELECT lower(hex(randomblob(16))), 'seeding', 1, id FROM SourceSeed
  `.execute(db);

  await sql`
    INSERT INTO PipelineTrigger (id, task, isProcessed, ofSourceSeedId)
    SELECT lower(hex(randomblob(16))), 'sourcing', isProcessed, id FROM SourceSeed
  `.execute(db);

  await sql`
    INSERT INTO PipelineTrigger (id, task, isProcessed, ofJobSourceId)
    SELECT lower(hex(randomblob(16))), 'listing', isProcessed, id FROM JobSource
  `.execute(db);

  await sql`
    INSERT INTO PipelineTrigger (id, task, isProcessed, ofJobListSourceId)
    SELECT lower(hex(randomblob(16))), 'scripting',
           CASE WHEN parserScript IS NOT NULL THEN 1 ELSE 0 END, id
    FROM JobListSource
  `.execute(db);

  await sql`
    INSERT INTO PipelineTrigger (id, task, isProcessed, ofJobListSourceId)
    SELECT lower(hex(randomblob(16))), 'run-scripts', isProcessed, id
    FROM JobListSource WHERE parserScript IS NOT NULL
  `.execute(db);

  await sql`
    INSERT INTO PipelineTrigger (id, task, isProcessed, ofJobPostId)
    SELECT lower(hex(randomblob(16))), 'viewing', isProcessed, id FROM JobPost
  `.execute(db);

  await sql`
    INSERT INTO PipelineTrigger (id, task, isProcessed, ofJobPostId)
    SELECT lower(hex(randomblob(16))), 'evaluate',
           CASE WHEN EXISTS (
             SELECT 1 FROM JobPostEval
              WHERE JobPostEval.ofJobPostId = JobPost.id
                AND JobPostEval.skillScore IS NOT NULL
           ) THEN 1 ELSE 0 END,
           id
    FROM JobPost WHERE isProcessed = 1
  `.execute(db);

  await db.schema.alterTable('SourceSeed').dropColumn('isProcessed').execute();
  await db.schema.alterTable('JobSource').dropColumn('isProcessed').execute();

  await db.schema
    .alterTable('JobListSource')
    .dropColumn('isProcessed')
    .execute();
  await db.schema.alterTable('JobPost').dropColumn('isProcessed').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('SourceSeed')
    .addColumn('isProcessed', sql`integer_boolean`, c =>
      c.notNull().defaultTo(Bool.False)
    )
    .execute();

  await db.schema
    .alterTable('JobSource')
    .addColumn('isProcessed', sql`integer_boolean`, c =>
      c.notNull().defaultTo(Bool.False)
    )
    .execute();

  await db.schema
    .alterTable('JobListSource')
    .addColumn('isProcessed', sql`integer_boolean`, c =>
      c.notNull().defaultTo(Bool.False)
    )
    .execute();

  await db.schema
    .alterTable('JobPost')
    .addColumn('isProcessed', sql`integer_boolean`, c =>
      c.notNull().defaultTo(Bool.False)
    )
    .execute();

  // Restore each flag from PipelineTrigger before dropping the table.
  await sql`
    UPDATE SourceSeed SET isProcessed = COALESCE((
      SELECT isProcessed FROM PipelineTrigger
       WHERE PipelineTrigger.ofSourceSeedId = SourceSeed.id
         AND PipelineTrigger.task = 'sourcing'
       LIMIT 1
    ), 0)
  `.execute(db);

  await sql`
    UPDATE JobSource SET isProcessed = COALESCE((
      SELECT isProcessed FROM PipelineTrigger
       WHERE PipelineTrigger.ofJobSourceId = JobSource.id
         AND PipelineTrigger.task = 'listing'
       LIMIT 1
    ), 0)
  `.execute(db);

  await sql`
    UPDATE JobListSource SET isProcessed = COALESCE((
      SELECT isProcessed FROM PipelineTrigger
       WHERE PipelineTrigger.ofJobListSourceId = JobListSource.id
         AND PipelineTrigger.task = 'run-scripts'
       LIMIT 1
    ), 0)
  `.execute(db);

  await sql`
    UPDATE JobPost SET isProcessed = COALESCE((
      SELECT isProcessed FROM PipelineTrigger
       WHERE PipelineTrigger.ofJobPostId = JobPost.id
         AND PipelineTrigger.task = 'viewing'
       LIMIT 1
    ), 0)
  `.execute(db);

  await db.schema.dropTable('PipelineTrigger').execute();
}
