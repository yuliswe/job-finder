import { Command } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import {
  MAX_CONCURRENT_BROWSER_TABS,
  PIPELINE_VIEWING_MIN_TITLE_RELEVANCY,
} from 'jobfinder.config.js';
import { Bool } from 'src/db/customTypes.js';
import { db } from 'src/db/index.js';
import { recordPipelineState } from 'src/db/pipelineState.js';
import {
  enqueueTrigger,
  markTriggerProcessed,
} from 'src/db/pipelineTrigger.js';
import { viewJobPost, type ViewedJobPost } from 'src/llm/viewJobPost.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';

const tabLimit = pLimit(MAX_CONCURRENT_BROWSER_TABS);

export function createViewingCommand(): Command {
  return new Command('viewing')
    .description(
      'For each unprocessed JobPost, open the URL and ask the LLM to populate title/company/location/description/salary/etc. fields'
    )
    .action(async () => {
      await withBrowserInstance(context => runAll(context));
    });
}

async function runAll(context: BrowserContext): Promise<void> {
  // Only view JobPosts whose title cleared the relevancy bar — anything below
  // is treated as junk per PIPELINE_VIEWING_MIN_TITLE_RELEVANCY.
  const targets = await db
    .selectFrom('JobPost')
    .innerJoin('JobPostEval', 'JobPostEval.ofJobPostId', 'JobPost.id')
    .select(['JobPost.id as id', 'JobPost.url as url'])
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('PipelineTrigger')
            .select('PipelineTrigger.id')
            .whereRef('PipelineTrigger.ofJobPostId', '=', 'JobPost.id')
            .where('PipelineTrigger.task', '=', 'viewing')
            .where('PipelineTrigger.isProcessed', '=', Bool.True)
        )
      )
    )
    .where(
      'JobPostEval.titleRelavency',
      '>=',
      PIPELINE_VIEWING_MIN_TITLE_RELEVANCY
    )
    .execute();

  if (targets.length === 0) {
    terminal.log('No unprocessed JobPost rows. Nothing to do.');
    return;
  }

  let updated = 0;
  await Promise.all(
    targets.map(target =>
      tabLimit(async () => {
        if (await processTarget(context, target)) updated++;
      })
    )
  );

  terminal.log(`Viewed and updated ${updated} JobPost rows\n`);
}

async function processTarget(
  context: BrowserContext,
  target: { id: string; url: string }
): Promise<boolean> {
  terminal.log(`Viewing JobPost ${target.url}`);

  let parsed: ViewedJobPost | null;
  try {
    parsed = await viewJobPost({ context, url: target.url });
  } catch (err) {
    terminal.error(`viewJobPost threw for ${target.url}: ${String(err)}`);
    await recordPipelineState({
      task: 'viewing',
      state: 'failed',
      reason: String(err).slice(0, 500),
      entity: { ofJobPostId: target.id },
    });
    return false;
  }

  if (!parsed) {
    await recordPipelineState({
      task: 'viewing',
      state: 'failed',
      reason: 'viewJobPost returned null (page load or LLM call failed)',
      entity: { ofJobPostId: target.id },
    });
    return false;
  }

  const update: Record<string, unknown> = {
    company: parsed.company,
    description: parsed.description,
    isRemote:
      parsed.isRemote === null
        ? null
        : parsed.isRemote
          ? Bool.True
          : Bool.False,
    jobType: parsed.jobType,
    location: parsed.location,
    postedAt: parsed.postedAt,
    salaryCurrency: parsed.salaryCurrency,
    salaryInterval: parsed.salaryInterval,
    salaryMax: parsed.salaryMax,
    salaryMin: parsed.salaryMin,
    summary: parsed.summary,
  };
  // Only overwrite title if the LLM produced one — preserve the run-scripts
  // title as a fallback otherwise.
  if (parsed.title) update.title = parsed.title;

  await db
    .updateTable('JobPost')
    .set(update)
    .where('id', '=', target.id)
    .execute();

  await recordPipelineState({
    task: 'viewing',
    state: 'done',
    entity: { ofJobPostId: target.id },
  });
  await markTriggerProcessed({
    task: 'viewing',
    entity: { ofJobPostId: target.id },
  });
  await enqueueTrigger({
    task: 'evaluate',
    entity: { ofJobPostId: target.id },
  });

  return true;
}
