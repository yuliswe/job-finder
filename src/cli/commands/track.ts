import { Command } from 'commander';

import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import { enqueuePipelineTask } from 'src/db/pipelineState.js';
import { classifyTrackedUrl } from 'src/llm/classifyTrackedUrl.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';

export function createTrackCommand(): Command {
  return new Command('track')
    .description(
      'Classify <url> via LLM as a job post / job list / neither. For a job post, enqueue sourcing on the company and viewing on the post. For a job list, enqueue sourcing and listing on the company. Exits non-zero when the URL is neither.'
    )
    .argument('<url>', 'URL of a job posting or a careers / jobs index page.')
    .action(async (url: string) => {
      await withBrowserInstance(context => runTrack(context, url));
    });
}

async function runTrack(
  context: import('patchright').BrowserContext,
  url: string
): Promise<void> {
  terminal.log(`Classifying ${url} …`);

  const classification = await classifyTrackedUrl({ context, url });
  if (!classification) {
    throw new Error(`Failed to classify ${url} — see LLM error above.`);
  }

  terminal.log(
    `pageType=${classification.pageType} company=${classification.companyName ?? '∅'} — ${classification.reason}`
  );

  if (classification.pageType === 'none') {
    throw new Error(
      `${url} does not appear to be a company job post or job list page. Reason: ${classification.reason}`
    );
  }

  const { companyName } = classification;
  if (!companyName) {
    // classifyTrackedUrl's validator already rejects this case, but the type
    // narrowing tells the caller below.
    throw new Error(
      `Classifier returned pageType="${classification.pageType}" with no company name.`
    );
  }

  const jobSourceId = await upsertJobSourceByName(companyName);

  await enqueuePipelineTask({
    task: 'sourcing',
    entity: { ofJobSourceId: jobSourceId },
  });

  if (classification.pageType === 'job_post') {
    const jobPostId = await upsertJobPost({
      url,
      ofJobSourceId: jobSourceId,
    });

    await enqueuePipelineTask({
      task: 'viewing',
      entity: { ofJobPostId: jobPostId },
    });

    terminal.log(
      `Tracked job post for "${companyName}" — queued sourcing on JobSource ${jobSourceId} and viewing on JobPost ${jobPostId}.`
    );
    return;
  }

  // pageType === 'job_list'
  await enqueuePipelineTask({
    task: 'listing',
    entity: { ofJobSourceId: jobSourceId },
  });

  terminal.log(
    `Tracked job list for "${companyName}" — queued sourcing and listing on JobSource ${jobSourceId}.`
  );
}

/** Insert a JobSource by name, or return the existing one's id when the
 * UNIQUE(name) constraint already holds a row. */
async function upsertJobSourceByName(name: string): Promise<string> {
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

/** Insert a JobPost with the tracked URL, or return the existing row's id
 * when the UNIQUE(url) constraint already holds one. `title` is a
 * placeholder — the viewing task overwrites it from the page itself.
 *
 * Also seeds a JobPostEval with `titleRelavency = 1.0` so the viewing
 * picker's `inScopeForViewing` check (which requires an eval row above
 * `PIPELINE_VIEWING_MIN_TITLE_RELEVANCY`) actually picks it up. Tracked
 * URLs are user-curated, so they bypass the relevance gate by design. */
async function upsertJobPost(args: {
  url: string;
  ofJobSourceId: string;
}): Promise<string> {
  const { url, ofJobSourceId } = args;

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
      titleRelavencyReason: 'Manually tracked via `jobfinder track`.',
    })
    .execute();

  return id;
}
