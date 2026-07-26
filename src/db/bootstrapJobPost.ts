import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';

/** Insert a JobSource by name, or return the existing one's id when the
 * UNIQUE(name) constraint already holds a row. This is the placeholder
 * "company" a bottom-up bootstrap (`track`, `fill-form`) creates before its
 * child JobPost; a later `research-company` run fills in its url / summary / interest.
 */
export async function upsertJobSourceByName(name: string): Promise<string> {
  const existing = await db
    .selectFrom('JobSource')
    .select('id')
    .where('name', '=', name)
    .executeTakeFirst();

  if (existing) return existing.id;

  const id = newId();
  await db.insertInto('JobSource').values({ id, name }).execute();
  return id;
}

/** Insert a JobPost with the given URL, or return the existing row's id when
 * the UNIQUE(url) constraint already holds one. `title` is a placeholder — the
 * view-job-detail task overwrites it from the page itself.
 *
 * Also seeds a JobPostEval with `titleRelavency = 1.0` so the view-job-detail picker's
 * `inScopeForViewJobDetail` check (which requires an eval row above
 * `PIPELINE_VIEW_JOB_DETAIL_MIN_TITLE_RELEVANCY`) actually picks it up. Manually
 * supplied URLs are user-curated, so they bypass the relevance gate by design.
 */
export async function upsertJobPost(args: {
  url: string;
  ofJobSourceId: string;
  reason?: string;
}): Promise<string> {
  const { url, ofJobSourceId, reason } = args;

  const existing = await db
    .selectFrom('JobPost')
    .select('id')
    .where('url', '=', url)
    .executeTakeFirst();

  if (existing) return existing.id;

  const id = newId();

  await db
    .insertInto('JobPost')
    .values({
      id,
      url,
      title: url,
      ofJobSourceId,
    })
    .execute();

  await db
    .insertInto('JobPostEval')
    .values({
      id: newId(),
      ofJobPostId: id,
      titleRelavency: 1.0,
      titleRelavencyReason: reason ?? 'Manually curated.',
    })
    .execute();

  return id;
}
