import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('JobPostEval')
    .addColumn('locationScore', 'real')
    .execute();

  await db.schema
    .alterTable('JobPostEval')
    .addColumn('locationScoreReason', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('JobPostEval')
    .dropColumn('locationScoreReason')
    .execute();

  await db.schema
    .alterTable('JobPostEval')
    .dropColumn('locationScore')
    .execute();
}
