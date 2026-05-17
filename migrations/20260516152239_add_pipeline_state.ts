import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('PipelineState')
    .addColumn('id', 'text', c => c.primaryKey().notNull())
    .addColumn('createdAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('updatedAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('task', 'text', c => c.notNull())
    .addColumn('state', 'text', c => c.notNull())
    .addColumn('reason', 'text')
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
    .createIndex('PipelineState_task_idx')
    .on('PipelineState')
    .column('task')
    .execute();

  await db.schema
    .createIndex('PipelineState_state_idx')
    .on('PipelineState')
    .column('state')
    .execute();

  await db.schema
    .createIndex('PipelineState_ofSourceSeedId_idx')
    .on('PipelineState')
    .column('ofSourceSeedId')
    .execute();

  await db.schema
    .createIndex('PipelineState_ofJobSourceId_idx')
    .on('PipelineState')
    .column('ofJobSourceId')
    .execute();

  await db.schema
    .createIndex('PipelineState_ofJobListSourceId_idx')
    .on('PipelineState')
    .column('ofJobListSourceId')
    .execute();

  await db.schema
    .createIndex('PipelineState_ofJobPostId_idx')
    .on('PipelineState')
    .column('ofJobPostId')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('PipelineState').execute();
}
