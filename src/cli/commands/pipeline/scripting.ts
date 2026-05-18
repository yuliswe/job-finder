import { Command } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'jobfinder.config.js';
import { jobListSourceInActiveSource } from 'src/db/activeSource.js';
import { db } from 'src/db/index.js';
import {
  enqueuePipelineTask,
  PIPELINE_STATE,
  processOne,
  recordPipelineState,
} from 'src/db/pipelineState.js';
import { generateParserScript } from 'src/llm/generateParserScript.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';

const tabLimit = pLimit(MAX_CONCURRENT_BROWSER_TABS);

export function createScriptingCommand(): Command {
  return new Command('scripting')
    .description(
      'For each unprocessed JobListSource, generate and validate a parser script (listLocations + searchJobs) and store it in JobListSource.parserScript'
    )
    .action(async () => {
      await withBrowserInstance(context => runScripting(context));
    });
}

async function runScripting(context: BrowserContext): Promise<void> {
  const targets = await db
    .selectFrom('JobListSource')
    .select(['id', 'url'])
    .where('parserScript', 'is', null)
    .where(jobListSourceInActiveSource)
    .execute();

  const results = await Promise.all(
    targets.map(target => tabLimit(() => scriptOneTarget({ context, target })))
  );
  const jobListSourceUpdated = results.reduce(
    (sum, r) => sum + (r?.jobListSourceUpdated ?? 0),
    0
  );

  terminal.log(
    `Updated ${jobListSourceUpdated} JobListSource rows with parser scripts\n`
  );
}

async function scriptOneTarget(args: {
  context: BrowserContext;
  target: { id: string; url: string };
}): Promise<{ jobListSourceUpdated: number } | undefined> {
  const { context, target } = args;
  return processOne({
    task: 'scripting',
    entity: { ofJobListSourceId: target.id },
    label: target.url,
    work: async (): Promise<{ jobListSourceUpdated: number }> => {
      terminal.log(`Scripting JobListSource ${target.url}`);

      const generated = await generateParserScript({
        context,
        listingUrl: target.url,
      });
      if (!generated) {
        terminal.warn(
          `Could not produce a validated script for ${target.url} — leaving unprocessed for retry`
        );
        await recordPipelineState({
          task: 'scripting',
          state: PIPELINE_STATE.ABORTED,
          reason:
            'generateParserScript returned null (LLM aborted or exhausted attempts)',
          entity: { ofJobListSourceId: target.id },
        });
        return { jobListSourceUpdated: 0 };
      }

      await db
        .updateTable('JobListSource')
        .set({
          parserScript: generated.parserScript,
          locations: JSON.stringify(generated.locations),
          divisions: JSON.stringify(generated.divisions),
        })
        .where('id', '=', target.id)
        .execute();

      await recordPipelineState({
        task: 'scripting',
        state: PIPELINE_STATE.DONE,
        entity: { ofJobListSourceId: target.id },
      });

      await enqueuePipelineTask({
        task: 'run-scripts',
        entity: { ofJobListSourceId: target.id },
      });

      return { jobListSourceUpdated: 1 };
    },
  });
}
