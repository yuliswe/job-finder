import { Argument, Command, Option } from 'commander';

import {
  FAILED_STATES,
  NO_RESULT_STATES,
  requeueAllInScope,
  requeueByLatestState,
  type RequeueableTask,
} from 'src/db/pipelineState.js';
import { terminal } from 'src/utils/terminal.js';

/** The stages `reset` can requeue. Mirrors `RequeueableTask` (every pipeline
 * task except `seeding`, which generates new SourceSeed rows rather than
 * re-picking existing ones). */
const STAGE_CHOICES: readonly RequeueableTask[] = [
  'sourcing',
  'listing',
  'scripting',
  'run-scripts',
  'viewing',
  'evaluate',
  'fill-form',
];

type ResetOptions = {
  all?: boolean;
  /** Commander turns the `--no-result` flag into the negation of an implicit
   * `result` boolean: `result` defaults to `true` and becomes `false` when
   * `--no-result` is passed. We read that below. */
  result?: boolean;
  failed?: boolean;
};

export function createResetCommand(): Command {
  return new Command('reset')
    .description(
      'Requeue tasks in a pipeline stage so the next run reprocesses them. Pick exactly one selector: --all (every in-scope entity), --no-result (entities whose latest state produced no result), or --failed (entities whose latest state is an error).'
    )
    .addArgument(
      new Argument('<stage>', 'Pipeline stage whose tasks to requeue.').choices(
        [...STAGE_CHOICES]
      )
    )
    .addOption(
      new Option(
        '--all',
        'Requeue every in-scope entity for the stage, including ones already done. Use after a prompt or config change.'
      )
    )
    .addOption(
      new Option(
        '--no-result',
        'Requeue only entities whose latest state produced no result (e.g. not_a_job_posting, no_listing_found).'
      )
    )
    .addOption(
      new Option(
        '--failed',
        'Requeue only entities whose latest state is a failure (failed, script_error, aborted).'
      )
    )
    .action(async (stage: RequeueableTask, opts: ResetOptions) => {
      // `--no-result` arrives as `opts.result === false` (see ResetOptions).
      const noResult = opts.result === false;
      const selectors = [
        opts.all === true,
        noResult,
        opts.failed === true,
      ].filter(Boolean);

      if (selectors.length !== 1) {
        terminal.error(
          'reset: pass exactly one of --all, --no-result, or --failed.'
        );
        process.exitCode = 1;
        return;
      }

      const count = opts.all
        ? await requeueAllInScope(stage)
        : noResult
          ? await requeueByLatestState(stage, NO_RESULT_STATES)
          : await requeueByLatestState(stage, FAILED_STATES);

      // `requeueAllInScope` already logs its own summary; the by-state paths
      // don't, so report their count here.
      if (!opts.all) {
        terminal.log(
          `reset ${stage}: requeued ${count} ${count === 1 ? 'entity' : 'entities'}.`
        );
      }
    });
}
