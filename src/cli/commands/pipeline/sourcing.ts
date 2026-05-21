import { Command, Option } from 'commander';
import pLimit from 'p-limit';

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
  inScopeForSourcing,
  neededForSourcing,
  qualifiedForSourcing,
} from 'src/db/pipelineQualified.js';
import { evaluateCompany } from 'src/llm/evaluateCompany.js';
import { findCompanyUrl } from 'src/llm/findCompanyUrl.js';
import { terminal } from 'src/utils/terminal.js';
import { getUserInterests } from 'src/utils/userInterests.js';

/** Soft cap on parallel LLM calls so we don't hammer the provider. */
const LLM_CONCURRENCY = 10;
const concurrency = pLimit(LLM_CONCURRENCY);

type SourcingOptions = {
  all?: boolean;
  includeFailed?: boolean;
  jobSourceId?: string;
};

export function createSourcingCommand(): Command {
  return new Command('sourcing')
    .description(
      'For every active JobSource with `url IS NULL`, ask the LLM (with web search) for the company URL and fill it in.'
    )
    .addOption(
      new Option(
        '--all',
        'Re-process every qualifying in-scope JobSource regardless of pipeline state. Use after a prompt change.'
      )
    )
    .addOption(
      new Option(
        '--include-failed',
        'Also retry rows in failed / aborted / no_result state (default skips them). Mutually exclusive with --all.'
      )
    )
    .option(
      '--job-source-id <id>',
      'Re-process only the JobSource with this ID, regardless of pipeline state or qualification.'
    )
    .action((opts: SourcingOptions) => runSourcing(opts));
}

async function runSourcing(opts: SourcingOptions): Promise<void> {
  if (opts.jobSourceId) {
    await enqueuePipelineTask({
      task: 'sourcing',
      entity: { ofJobSourceId: opts.jobSourceId },
    });
  }

  const mode = pipelineModeFromOptions(opts);
  if (mode === 'all') await requeueAllInScope('sourcing');

  // Picker = qualifiedForX ∩ inScopeForX [∩ neededForX] + state filter.
  // `--all` deliberately drops `neededForSourcing` so already-complete rows
  // get re-processed (the documented purpose: "re-process every in-scope
  // row, e.g. after a prompt change"). Default and `--include-failed`
  // still apply `neededForSourcing` so rows whose output columns are all
  // filled are skipped.
  const stateFilter = pickerStateFilter({
    task: 'sourcing',
    parentIdRef: 'JobSource.id',
    mode,
  });

  let query = db
    .selectFrom('JobSource')
    .select(['id', 'name', 'url'])
    .where(qualifiedForSourcing)
    .where(inScopeForSourcing);

  if (mode !== 'all') query = query.where(neededForSourcing);
  if (stateFilter) query = query.where(stateFilter);

  const sources = opts.jobSourceId
    ? await db
        .selectFrom('JobSource')
        .select(['id', 'name', 'url'])
        .where('JobSource.id', '=', opts.jobSourceId)
        .execute()
    : await query.execute();

  if (sources.length === 0) {
    terminal.log('No JobSource rows need sourcing. Nothing to do.');
    return;
  }

  // Read interests once up front. Empty is OK — `findCompanyUrl` scores 0.0
  // with an explanatory reason in that case.
  const interests = await getUserInterests();

  const results = await Promise.all(
    sources.map(source =>
      concurrency(() => sourceOneJobSource({ source, interests }))
    )
  );

  const filled = results.reduce((sum, r) => sum + (r?.urlFilled ?? 0), 0);
  terminal.log(`Filled url on ${filled} JobSource row(s)\n`);
}

async function sourceOneJobSource(args: {
  source: { id: string; name: string; url: string | null };
  interests: string;
}): Promise<{ urlFilled: number } | undefined> {
  const { source, interests } = args;
  return processOne({
    task: 'sourcing',
    entity: { ofJobSourceId: source.id },
    label: source.name,
    work: async (): Promise<{ urlFilled: number }> => {
      // URL is already set — only the research fields (summary / interest)
      // need filling. Skip the URL-discovery question entirely so a flaky
      // web search can't corrupt a previously-correct URL.
      if (source.url != null) {
        const research = await evaluateCompany({
          name: source.name,
          url: source.url,
          interests,
        });

        await db
          .updateTable('JobSource')
          .set({
            summary: research.summary,
            interestScore: research.interestScore,
            interestScoreReason: research.interestScoreReason,
          })
          .where('id', '=', source.id)
          .execute();

        await recordPipelineState({
          task: 'sourcing',
          state: PIPELINE_STATE.DONE,
          entity: { ofJobSourceId: source.id },
        });
        return { urlFilled: 0 };
      }

      const evaluation = await findCompanyUrl({ name: source.name, interests });

      const evalFields = {
        summary: evaluation.summary,
        interestScore: evaluation.interestScore,
        interestScoreReason: evaluation.interestScoreReason,
      };

      // No URL — still record summary + interest signal on the current
      // row, then bail out with no_source_found. Nothing to merge against.
      if (evaluation.url == null) {
        await db
          .updateTable('JobSource')
          .set(evalFields)
          .where('id', '=', source.id)
          .execute();

        await recordPipelineState({
          task: 'sourcing',
          state: PIPELINE_STATE.NO_SOURCE_FOUND,
          entity: { ofJobSourceId: source.id },
        });
        return { urlFilled: 0 };
      }

      // URL UNIQUE conflict = the LLM resolved a different name to a URL
      // that another JobSource already holds (e.g. "Acme" + "Acme Inc." →
      // "acme.com"). Drop the current row (its children cascade —
      // listings/posts/state) but DO NOT touch the survivor's columns:
      // the LLM's reasoning for this call was framed around `source.name`,
      // not the survivor's name, so its summary/interestScore/reason are
      // unreliable signal for the survivor. The survivor keeps whatever
      // values it got from its own (correctly-named) sourcing run.
      const existing = await db
        .selectFrom('JobSource')
        .select('id')
        .where('url', '=', evaluation.url)
        .where('id', '!=', source.id)
        .executeTakeFirst();

      if (existing) {
        await db.deleteFrom('JobSource').where('id', '=', source.id).execute();

        terminal.log(
          `Dropped "${source.name}" — its url ${evaluation.url} is already held by JobSource ${existing.id}.`
        );
        return { urlFilled: 0 };
      }

      await db
        .updateTable('JobSource')
        .set({ url: evaluation.url, ...evalFields })
        .where('id', '=', source.id)
        .execute();

      await recordPipelineState({
        task: 'sourcing',
        state: PIPELINE_STATE.DONE,
        entity: { ofJobSourceId: source.id },
      });

      await enqueuePipelineTask({
        task: 'listing',
        entity: { ofJobSourceId: source.id },
      });

      return { urlFilled: 1 };
    },
  });
}
