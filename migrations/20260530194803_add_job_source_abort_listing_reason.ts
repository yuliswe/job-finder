import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('JobSource')
    .addColumn('abortListingReason', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('JobSource')
    .dropColumn('abortListingReason')
    .execute();
}
