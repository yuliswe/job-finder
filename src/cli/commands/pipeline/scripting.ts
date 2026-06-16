import { Command, Option } from 'commander';
import pLimit from 'p-limit';
import type { BrowserContext } from 'patchright';

import {
  LLM_CODING_MODEL_CHEAPER,
  LLM_CODING_MODEL_SMARTER,
  MAX_CONCURRENT_BROWSER_TABS,
} from 'jobfinder.config.js';
import { db } from 'src/db/index.js';
import {
  enqueuePipelineTask,
  PIPELINE_STATE,
  pickerStateFilter,
  pipelineModeFromOptions,
  processOne,
  recordPipelineState,
  requeueAllInScope,
} from 'src/db/pipelineState.js';
import {
  inScopeForScripting,
  qualifiedForScripting,
} from 'src/db/pipelineQualified.js';
import { generateParserScript } from 'src/llm/generateParserScript.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';

const tabLimit = pLimit(MAX_CONCURRENT_BROWSER_TABS);

type ScriptingOptions = {
  all?: boolean;
  includeFailed?: boolean;
  jobListSourceId?: string;
  /** Suppress "nothing to do" / "0 rows" log lines. See SourcingOptions. */
  suppressNothingToDoLog?: boolean;
};

export function createScriptingCommand(): Command {
  return new Command('scripting')
    .description(
      'Generate and validate a parser script (listLocations + searchJobs) for each currently-queued JobListSource and store it in JobListSource.parserScript.'
    )
    .addOption(
      new Option(
        '--all',
        'Re-process every qualifying in-scope JobListSource regardless of pipeline state. Re-scripts done rows and overwrites their parserScript on success. Use after a prompt change.'
      )
    )
    .addOption(
      new Option(
        '--include-failed',
        'Also retry rows in failed / aborted / no_result state (default skips them). Mutually exclusive with --all.'
      )
    )
    .option(
      '--job-list-source-id <id>',
      'Re-process only the JobListSource with this ID, regardless of pipeline state or qualification.'
    )
    .action(async (opts: ScriptingOptions) => {
      await withBrowserInstance(context => runScripting(context, opts));
    });
}

export async function runScripting(
  context: BrowserContext,
  opts: ScriptingOptions
): Promise<{ processed: number }> {
  if (opts.jobListSourceId) {
    const exists = await db
      .selectFrom('JobListSource')
      .select('id')
      .where('id', '=', opts.jobListSourceId)
      .executeTakeFirst();

    if (!exists) {
      throw new Error(
        `JobListSource with id ${opts.jobListSourceId} not found.`
      );
    }

    await enqueuePipelineTask({
      task: 'scripting',
      entity: { ofJobListSourceId: opts.jobListSourceId },
    });
  }

  const mode = pipelineModeFromOptions(opts);
  if (mode === 'all') await requeueAllInScope('scripting');

  // Picker = qualifiedForX ∩ inScopeForX + state filter chosen by mode.
  const stateFilter = pickerStateFilter({
    task: 'scripting',
    parentIdRef: 'JobListSource.id',
    mode,
  });

  let query = db
    .selectFrom('JobListSource')
    .select(['id', 'url'])
    .where(qualifiedForScripting)
    .where(inScopeForScripting);

  if (stateFilter) query = query.where(stateFilter);

  const targets = opts.jobListSourceId
    ? await db
        .selectFrom('JobListSource')
        .select(['id', 'url'])
        .where('JobListSource.id', '=', opts.jobListSourceId)
        .execute()
    : await query.execute();

  const results = await Promise.all(
    targets.map(target => tabLimit(() => scriptOneTarget({ context, target })))
  );

  const jobListSourceUpdated = results.reduce(
    (sum, r) => sum + (r?.jobListSourceUpdated ?? 0),
    0
  );

  if (jobListSourceUpdated > 0 || !opts.suppressNothingToDoLog) {
    terminal.log(
      `Updated ${jobListSourceUpdated} JobListSource rows with parser scripts\n`
    );
  }

  return { processed: targets.length };
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
      terminal.log(
        `Scripting JobListSource ${target.url} (models=${LLM_CODING_MODEL_CHEAPER.join(',')})`
      );

      let generated = await generateParserScript({
        context,
        listingUrl: target.url,
        models: LLM_CODING_MODEL_CHEAPER,
      });

      if (!generated) {
        terminal.warn(
          `Base models (${LLM_CODING_MODEL_CHEAPER.join(',')}) could not produce a validated script for ${target.url}. Retrying with smarter models (${LLM_CODING_MODEL_SMARTER.join(',')}).`
        );

        generated = await generateParserScript({
          context,
          listingUrl: target.url,
          models: LLM_CODING_MODEL_SMARTER,
        });
      }

      if (!generated) {
        terminal.warn(
          `Neither base nor smarter model produced a validated script for ${target.url} — leaving unprocessed for retry`
        );

        await recordPipelineState({
          task: 'scripting',
          state: PIPELINE_STATE.ABORTED,
          reason:
            'generateParserScript returned null with both LLM_CODING_MODEL_BASE and LLM_CODING_MODEL_SMARTER (LLM aborted or exhausted attempts)',
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
