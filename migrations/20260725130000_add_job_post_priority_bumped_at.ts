import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Timestamp of the last manual priority bump, NULL when the post was never
  // bumped. The viewing/evaluate pickers order by it (DESC NULLS LAST) so a
  // bumped post is picked up ahead of the backlog, and a more recent bump
  // outranks an older one ("stackable by recency"). See
  // `pickViewingTargets` / `pickEvaluateTargets`.
  await db.schema
    .alterTable('JobPost')
    .addColumn('priorityBumpedAt', 'text')
    .execute();

  await db.schema
    .createIndex('JobPost_priorityBumpedAt_idx')
    .on('JobPost')
    .column('priorityBumpedAt')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('JobPost_priorityBumpedAt_idx').execute();

  await db.schema
    .alterTable('JobPost')
    .dropColumn('priorityBumpedAt')
    .execute();
}
