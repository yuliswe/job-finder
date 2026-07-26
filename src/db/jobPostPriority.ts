import { db } from 'src/db/index.js';

/** Set or clear the manual priority bump on a JobPost. `bumpedAt` is an ISO
 * timestamp to prioritize the post, or `null` to clear it. The view-job-detail and
 * evaluate pickers order by this column (DESC NULLS LAST), so a bumped post is
 * picked ahead of the backlog and a more recent bump outranks an older one
 * ("stackable by recency"). Throws when no JobPost has the given id. */
export async function setJobPostPriorityBump(
  jobPostId: string,
  bumpedAt: string | null
): Promise<void> {
  const res = await db
    .updateTable('JobPost')
    .set({ priorityBumpedAt: bumpedAt })
    .where('id', '=', jobPostId)
    .executeTakeFirst();

  if (res.numUpdatedRows === 0n) {
    throw new Error(`JobPost with id ${jobPostId} not found.`);
  }
}

/** Current bump timestamp for a JobPost, or `null` when it is not bumped.
 * Throws when no JobPost has the given id. */
export async function getJobPostPriorityBump(
  jobPostId: string
): Promise<string | null> {
  const row = await db
    .selectFrom('JobPost')
    .select('priorityBumpedAt')
    .where('id', '=', jobPostId)
    .executeTakeFirst();

  if (!row) throw new Error(`JobPost with id ${jobPostId} not found.`);
  return row.priorityBumpedAt;
}
