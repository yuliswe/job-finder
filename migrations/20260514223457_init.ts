import { Kysely, sql } from 'kysely';

import { Bool } from 'src/db/customTypes.js';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('JobSource')
    .addColumn('id', 'text', c => c.primaryKey().notNull())
    .addColumn('createdAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('updatedAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('name', 'text', c => c.notNull())
    .addColumn('url', 'text', c => c.notNull().unique())
    .addColumn('isActive', sql`integer_boolean`, c =>
      c.notNull().defaultTo(Bool.True)
    )
    .addColumn('isProcessed', sql`integer_boolean`, c =>
      c.notNull().defaultTo(Bool.False)
    )
    .execute();

  await db.schema
    .createIndex('JobSource_isActive_idx')
    .on('JobSource')
    .column('isActive')
    .execute();

  await db.schema
    .createTable('JobListSource')
    .addColumn('id', 'text', c => c.primaryKey().notNull())
    .addColumn('createdAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('updatedAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('url', 'text', c => c.notNull().unique())
    .addColumn('parserScript', 'text')
    .addColumn('isActive', sql`integer_boolean`, c =>
      c.notNull().defaultTo(Bool.True)
    )
    .addColumn('isProcessed', sql`integer_boolean`, c =>
      c.notNull().defaultTo(Bool.False)
    )
    .addColumn('ofJobSourceId', 'text', c =>
      c.notNull().references('JobSource.id').onDelete('cascade')
    )
    .execute();

  await db.schema
    .createIndex('JobListSource_ofJobSourceId_idx')
    .on('JobListSource')
    .column('ofJobSourceId')
    .execute();

  await db.schema
    .createIndex('JobListSource_isActive_idx')
    .on('JobListSource')
    .column('isActive')
    .execute();

  await db.schema
    .createTable('JobPost')
    .addColumn('id', 'text', c => c.primaryKey().notNull())
    .addColumn('createdAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('updatedAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('url', 'text', c => c.notNull().unique())
    .addColumn('title', 'text', c => c.notNull())
    .addColumn('company', 'text')
    .addColumn('location', 'text')
    .addColumn('description', 'text')
    .addColumn('summary', 'text')
    .addColumn('postedAt', sql`text_datetime`)
    .addColumn('jobType', 'text')
    .addColumn('isRemote', sql`integer_boolean`)
    .addColumn('salaryMin', 'real')
    .addColumn('salaryMax', 'real')
    .addColumn('salaryCurrency', 'text')
    .addColumn('salaryInterval', 'text')
    .addColumn('isProcessed', sql`integer_boolean`, c =>
      c.notNull().defaultTo(Bool.False)
    )
    .addColumn('ofJobSourceId', 'text', c =>
      c.notNull().references('JobSource.id').onDelete('cascade')
    )
    .addColumn('ofJobListSourceId', 'text', c =>
      c.references('JobListSource.id').onDelete('set null')
    )
    .execute();

  await db.schema
    .createIndex('JobPost_ofJobSourceId_idx')
    .on('JobPost')
    .column('ofJobSourceId')
    .execute();

  await db.schema
    .createIndex('JobPost_ofJobListSourceId_idx')
    .on('JobPost')
    .column('ofJobListSourceId')
    .execute();

  await db.schema
    .createIndex('JobPost_postedAt_idx')
    .on('JobPost')
    .column('postedAt')
    .execute();

  await db.schema
    .createIndex('JobPost_createdAt_idx')
    .on('JobPost')
    .column('createdAt')
    .execute();

  await db.schema
    .createTable('SourceSeed')
    .addColumn('id', 'text', c => c.primaryKey().notNull())
    .addColumn('createdAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('updatedAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('url', 'text', c => c.notNull().unique())
    .addColumn('name', 'text', c => c.notNull())
    .addColumn('title', 'text', c => c.notNull())
    .addColumn('isProcessed', sql`integer_boolean`, c =>
      c.notNull().defaultTo(Bool.False)
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('SourceSeed').execute();
  await db.schema.dropTable('JobPost').execute();
  await db.schema.dropTable('JobListSource').execute();
  await db.schema.dropTable('JobSource').execute();
}
