import { Command } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import { MAX_CONCURRENT_BROWSER_TABS } from 'jobfinder.config.js';
import { db } from 'src/db/index.js';
import { recordPipelineState } from 'src/db/pipelineState.js';
import {
  enqueueTrigger,
  markTriggerProcessed,
} from 'src/db/pipelineTrigger.js';
import {
  generateParserScript,
  type GeneratedParserScript,
} from 'src/llm/generateParserScript.js';
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
    .execute();

  let updated = 0;
  await Promise.all(
    targets.map(target =>
      tabLimit(async () => {
        await processTarget(context, target);
        updated += 1;
      })
    )
  );

  terminal.log(`Updated ${updated} JobListSource rows with parser scripts\n`);
}

async function processTarget(
  context: BrowserContext,
  target: { id: string; url: string }
): Promise<void> {
  terminal.log(`Scripting JobListSource ${target.url}`);

  let generated: GeneratedParserScript | null;
  try {
    generated = await generateParserScript({
      context,
      listingUrl: target.url,
    });
  } catch (err) {
    terminal.error(
      `generateParserScript threw for ${target.url}: ${String(err)}`
    );
    await recordPipelineState({
      task: 'scripting',
      state: 'failed',
      reason: String(err).slice(0, 500),
      entity: { ofJobListSourceId: target.id },
    });
    return;
  }

  if (!generated) {
    terminal.warn(
      `Could not produce a validated script for ${target.url} — leaving unprocessed for retry`
    );
    await recordPipelineState({
      task: 'scripting',
      state: 'aborted',
      reason:
        'generateParserScript returned null (LLM aborted or exhausted attempts)',
      entity: { ofJobListSourceId: target.id },
    });
    return;
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
    state: 'done',
    entity: { ofJobListSourceId: target.id },
  });
  await markTriggerProcessed({
    task: 'scripting',
    entity: { ofJobListSourceId: target.id },
  });
  await enqueueTrigger({
    task: 'run-scripts',
    entity: { ofJobListSourceId: target.id },
  });
}
