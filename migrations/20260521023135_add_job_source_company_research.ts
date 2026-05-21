import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('JobSource')
    .addColumn('summary', 'text')
    .execute();

  await db.schema
    .alterTable('JobSource')
    .addColumn('interestScore', 'real')
    .execute();

  await db.schema
    .alterTable('JobSource')
    .addColumn('interestScoreReason', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('JobSource')
    .dropColumn('interestScoreReason')
    .execute();

  await db.schema.alterTable('JobSource').dropColumn('interestScore').execute();

  await db.schema.alterTable('JobSource').dropColumn('summary').execute();
}
