import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('JobPostEval')
    .addColumn('locationRelevancy', 'real')
    .execute();

  await db.schema
    .alterTable('JobPostEval')
    .addColumn('locationRelevancyReason', 'text')
    .execute();

  await db.schema
    .createIndex('JobPostEval_locationRelevancy_idx')
    .on('JobPostEval')
    .column('locationRelevancy')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('JobPostEval_locationRelevancy_idx').execute();

  await db.schema
    .alterTable('JobPostEval')
    .dropColumn('locationRelevancyReason')
    .execute();

  await db.schema
    .alterTable('JobPostEval')
    .dropColumn('locationRelevancy')
    .execute();
}
