import { Kysely } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Records where `JobPost.postedAt` was derived from. NULL when we have no
  // posted date at all. 'job_post' when the LLM extracted it from the job
  // page itself. 'twbm' when we fell back to the Wayback Machine's earliest
  // snapshot date for the URL (in which case the displayed days-ago value
  // is a *lower bound*, not an exact match — the TUI renders it as ">N").
  await db.schema
    .alterTable('JobPost')
    .addColumn('postedAtSource', 'text')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('JobPost').dropColumn('postedAtSource').execute();
}
