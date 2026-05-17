import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('JobPostEval')
    .addColumn('id', 'text', c => c.primaryKey().notNull())
    .addColumn('createdAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('updatedAt', sql`text_datetime`, c =>
      c.notNull().defaultTo(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
    )
    .addColumn('titleRelavency', 'real')
    .addColumn('titleRelavencyReason', 'text')
    .addColumn('interestScore', 'real')
    .addColumn('interestScoreReason', 'text')
    .addColumn('skillScore', 'real')
    .addColumn('skillScoreReason', 'text')
    .addColumn('skillScoreBreakdown', 'text')
    .addColumn('ofJobPostId', 'text', c =>
      c.notNull().references('JobPost.id').onDelete('cascade')
    )
    .execute();

  await db.schema
    .createIndex('JobPostEval_ofJobPostId_idx')
    .on('JobPostEval')
    .column('ofJobPostId')
    .unique()
    .execute();

  await db.schema
    .createIndex('JobPostEval_titleRelavency_idx')
    .on('JobPostEval')
    .column('titleRelavency')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('JobPostEval').execute();
}
