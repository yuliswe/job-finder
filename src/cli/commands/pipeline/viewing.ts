import { Command } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import {
  MAX_CONCURRENT_BROWSER_TABS,
  PIPELINE_VIEWING_MIN_TITLE_RELEVANCY,
} from 'jobfinder.config.js';
import { jobPostInActiveSource } from 'src/db/activeSource.js';
import { Bool } from 'src/db/customTypes.js';
import { db } from 'src/db/index.js';
import { processOne, recordPipelineState } from 'src/db/pipelineState.js';
import {
  enqueueTrigger,
  markTriggerProcessed,
} from 'src/db/pipelineTrigger.js';
import { viewJobPost } from 'src/llm/viewJobPost.js';
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
    .where(jobPostInActiveSource)
    .execute();

  if (targets.length === 0) {
    terminal.log('No unprocessed JobPost rows. Nothing to do.');
    return;
  }

  const results = await Promise.all(
    targets.map(target => tabLimit(() => viewOneTarget({ context, target })))
  );
  const jobPostUpdated = results.reduce(
    (sum, r) => sum + (r?.jobPostUpdated ?? 0),
    0
  );

  terminal.log(`Viewed and updated ${jobPostUpdated} JobPost rows\n`);
}

async function viewOneTarget(args: {
  context: BrowserContext;
  target: { id: string; url: string };
}): Promise<{ jobPostUpdated: number } | undefined> {
  const { context, target } = args;
  return processOne({
    task: 'viewing',
    entity: { ofJobPostId: target.id },
    label: target.url,
    work: async (): Promise<{ jobPostUpdated: number }> => {
      terminal.log(`Viewing JobPost ${target.url}`);

      const parsed = await viewJobPost({ context, url: target.url });
      if (!parsed) {
        await recordPipelineState({
          task: 'viewing',
          state: 'failed',
          reason: 'viewJobPost returned null (page load or LLM call failed)',
          entity: { ofJobPostId: target.id },
        });
        return { jobPostUpdated: 0 };
      }
      if (!parsed.isJobPosting) {
        // LLM determined the URL is not a job posting (expired, login wall,
        // error page, listings page, etc.). Treat this as a terminal verdict
        // so we stop re-attempting it on every pipeline run.
        await recordPipelineState({
          task: 'viewing',
          state: 'not_a_job_posting',
          reason: 'LLM reported the page is not a job posting',
          entity: { ofJobPostId: target.id },
        });
        await markTriggerProcessed({
          task: 'viewing',
          entity: { ofJobPostId: target.id },
        });
        return { jobPostUpdated: 0 };
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
      // Only overwrite title if the LLM produced one — preserve the
      // run-scripts title as a fallback otherwise.
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
      return { jobPostUpdated: 1 };
    },
  });
}
