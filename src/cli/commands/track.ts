import { Command } from 'commander';

import {
  upsertJobPost,
  upsertJobSourceByName,
} from 'src/db/bootstrapJobPost.js';
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
      reason: 'Manually tracked via `jobfinder track`.',
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
