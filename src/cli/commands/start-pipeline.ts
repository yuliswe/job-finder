import { Command, Option } from 'commander';
import type { BrowserContext } from 'patchright';

import { acquirePipelineLock } from 'src/cli/commands/pipeline/pipelineLock.js';
import { runEvaluateSkillMatch } from 'src/cli/commands/pipeline/evaluate-skill-match.js';
import { runIdentifyJobListUrl } from 'src/cli/commands/pipeline/identify-job-list-url.js';
import { runApplyFilters } from 'src/cli/commands/pipeline/apply-filters.js';
import { runLearnToUseJobList } from 'src/cli/commands/pipeline/learn-to-use-job-list.js';
import { runResearchCompany } from 'src/cli/commands/pipeline/research-company.js';
import { runViewJobDetail } from 'src/cli/commands/pipeline/view-job-detail.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';

/** Per-task opts forwarded to each runX. We only thread the bits start-pipeline
 * cares about; runX functions accept additional task-specific fields
 * (division/location/jobSourceId/etc.) that we never set here. */
type IterationOpts = {
  includeFailed?: boolean;
  suppressNothingToDoLog?: boolean;
};

/** Idle-poll interval applied only when a task's previous iteration found
 * nothing to do. Iterations that processed >0 items re-loop immediately. */
const IDLE_POLL_MS = 5_000;

type TaskName =
  | 'research-company'
  | 'identify-job-list-url'
  | 'learn-to-use-job-list'
  | 'apply-filters'
  | 'view-job-detail'
  | 'evaluate-skill-match';

const TASKS: readonly TaskName[] = [
  'research-company',
  'identify-job-list-url',
  'learn-to-use-job-list',
  'apply-filters',
  'view-job-detail',
  'evaluate-skill-match',
];

/** Tasks that surface results to the user (a fetched post's fields, then its
 * scores). They run without deference. The remaining upstream tasks keep
 * generating more JobPosts to view/evaluate, so we let those two drain their
 * backlog before upstream produces more — see `PRIORITY_TASKS` usage in
 * `runLoop`. */
const PRIORITY_TASKS: readonly TaskName[] = [
  'view-job-detail',
  'evaluate-skill-match',
];

/** Per-task bookkeeping the global drain check consults after every iteration.
 * `lastSeenGen` is the value of `gen` observed at the end of the task's most
 * recent iteration — paired with `lastProcessed===0` and `!running` it proves
 * the task has actually seen every recent productive iteration AND found
 * nothing of its own to do. */
type TaskState = {
  running: boolean;
  lastProcessed: number;
  lastSeenGen: number;
};

type Orchestrator = {
  gen: number;
  shutdown: boolean;
  state: Record<TaskName, TaskState>;
  /** Resolvers of every currently-sleeping task, cleared by `wakeAll`. */
  sleepers: Set<() => void>;
};

type StartPipelineOptions = {
  includeFailed?: boolean;
  force?: boolean;
};

export function createStartPipelineCommand(): Command {
  return new Command('start-pipeline')
    .description(
      'Run research-company, identify-job-list-url, learn-to-use-job-list, apply-filters, view-job-detail, and evaluate-skill-match concurrently in independent loops until every queue drains. view-job-detail and evaluate-skill-match are prioritized: the upstream tasks (research-company/identify-job-list-url/learn-to-use-job-list/apply-filters) defer their next iteration while either of those two still has work, so the current backlog is fetched and evaluated before more JobPosts are generated. Each loop sleeps 5s only when its previous iteration found nothing to do.'
    )
    .addOption(
      new Option(
        '--include-failed',
        'Pass --include-failed to each task on its FIRST iteration only — same picker semantics as `jobfinder pipeline <task> --include-failed`, applied once at the start so failed / aborted / no_result rows get retried. Subsequent iterations of each loop run in default queued-only mode so a fresh failure during the run is not retried forever.'
      )
    )
    .addOption(
      new Option(
        '--force',
        'Start even if another instance holds this database’s pipeline lock. Only for when you are certain the recorded holder is dead — two live runs double-process every row and make the stale-started reap requeue each other’s in-flight work.'
      )
    )
    .action(runAllLoops);
}

async function runAllLoops(opts: StartPipelineOptions): Promise<void> {
  // Refuse to run a second instance against the same database: concurrent
  // pickers double-process every queued row, and each run's startup reap would
  // requeue the other's legitimately in-flight `started` rows as if they were
  // crash orphans. --force overrides when the recorded holder is known dead.
  const lock = acquirePipelineLock(undefined, { force: opts.force });
  if (!lock.acquired) {
    terminal.error(
      `start-pipeline is already running against this database (pid ${lock.holderPid}). Stop it first, or pass --force if you are certain that process is dead.`
    );

    // `cli.ts` finishes with an unconditional `process.exit(0)`, so setting
    // `process.exitCode` here would be overwritten; exit non-zero directly so
    // callers and scripts can detect the refusal. Nothing to release — we
    // never acquired the lock.
    process.exit(1);
  }

  try {
    await runAllLoopsLocked(opts);
  } finally {
    lock.release();
  }
}

async function runAllLoopsLocked(opts: StartPipelineOptions): Promise<void> {
  // `running: true` at init is a "not yet completed first iteration" sentinel.
  // Without it, a fast no-browser task (evaluate-skill-match) can finish its first
  // iteration before the browser-using tasks have even returned from
  // `withBrowserInstance`'s chromium launch — making the drain check pass
  // against state that's actually "hasn't started" rather than "drained".
  const state = Object.fromEntries(
    TASKS.map(name => [
      name,
      { running: true, lastProcessed: 0, lastSeenGen: 0 },
    ])
  ) as Record<TaskName, TaskState>;

  const orchestrator: Orchestrator = {
    gen: 0,
    shutdown: false,
    state,
    sleepers: new Set(),
  };

  terminal.log(
    `Starting start-pipeline orchestrator: ${TASKS.length} tasks (prioritizing ${PRIORITY_TASKS.join(' + ')}), idle poll = ${IDLE_POLL_MS / 1000}s${opts.includeFailed ? ' (--include-failed: passed to each task on first iteration)' : ''}`
  );

  // Every iteration runs with suppressNothingToDoLog so tasks don't
  // spam "Nothing to do" / "Inserted 0 rows" every 5s. Individual
  // `jobfinder pipeline <task>` invocations leave the flag false so the
  // user still gets actionable feedback there.
  //
  // First-iteration ALSO carries `includeFailed` when the orchestrator
  // was launched with --include-failed. After the first call, each task
  // drops to plain `{ suppressNothingToDoLog: true }` for the rest of
  // the run — same queued-only picker semantics as the normal default.
  const firstOpts: IterationOpts = opts.includeFailed
    ? { includeFailed: true, suppressNothingToDoLog: true }
    : { suppressNothingToDoLog: true };

  await Promise.all([
    runLoopWithBrowser(
      orchestrator,
      'research-company',
      firstOpts,
      (ctx, iterOpts) => runResearchCompany(ctx, iterOpts)
    ),
    runLoopWithBrowser(
      orchestrator,
      'identify-job-list-url',
      firstOpts,
      (ctx, iterOpts) => runIdentifyJobListUrl(ctx, iterOpts)
    ),
    runLoopWithBrowser(
      orchestrator,
      'learn-to-use-job-list',
      firstOpts,
      (ctx, iterOpts) => runLearnToUseJobList(ctx, iterOpts)
    ),
    runLoopWithBrowser(
      orchestrator,
      'apply-filters',
      firstOpts,
      (ctx, iterOpts) => runApplyFilters(ctx, iterOpts)
    ),
    runLoopWithBrowser(
      orchestrator,
      'view-job-detail',
      firstOpts,
      (ctx, iterOpts) => runViewJobDetail(ctx, iterOpts)
    ),
    runLoop(orchestrator, 'evaluate-skill-match', firstOpts, iterOpts =>
      runEvaluateSkillMatch(iterOpts)
    ),
  ]);

  terminal.log('All pipeline tasks drained. Shutting down.');
}

async function runLoopWithBrowser(
  orchestrator: Orchestrator,
  name: TaskName,
  firstOpts: IterationOpts,
  fn: (
    ctx: BrowserContext,
    iterOpts: IterationOpts
  ) => Promise<{ processed: number }>
): Promise<void> {
  await withBrowserInstance(context =>
    runLoop(orchestrator, name, firstOpts, iterOpts => fn(context, iterOpts))
  );
}

async function runLoop(
  orchestrator: Orchestrator,
  name: TaskName,
  firstOpts: IterationOpts,
  fn: (iterOpts: IterationOpts) => Promise<{ processed: number }>
): Promise<void> {
  const slot = orchestrator.state[name];
  const deprioritized = !PRIORITY_TASKS.includes(name);
  // `firstOpts` (e.g. {includeFailed:true, suppressNothingToDoLog:true}
  // from --include-failed) is consumed on iteration 1 only; subsequent
  // iterations get `{ suppressNothingToDoLog: true }` so a failure
  // inside the run doesn't keep retrying forever AND the per-poll spam
  // stays suppressed.
  let nextOpts: IterationOpts = firstOpts;

  while (!orchestrator.shutdown) {
    // Deprioritized (upstream) tasks yield to view-job-detail/evaluate-skill-match: they don't
    // start an iteration while either priority task is still running or its
    // most recent iteration processed work. This makes start-pipeline surface
    // fetched/evaluated results for the current backlog before generating more
    // JobPosts. `slot.running` stays false during the wait, but the priority
    // tasks' own `running` flags keep `isFullyDrained` from firing early.
    if (deprioritized) {
      while (!orchestrator.shutdown && priorityTasksBusy(orchestrator)) {
        await sleepInterruptible(orchestrator, IDLE_POLL_MS);
      }

      if (orchestrator.shutdown) break;
    }

    slot.running = true;
    let processed = 0;
    const iterOpts = nextOpts;
    nextOpts = { suppressNothingToDoLog: true };
    try {
      ({ processed } = await fn(iterOpts));
    } catch (err) {
      terminal.error(`[${name}] iteration failed: ${String(err)}`);
    }

    slot.running = false;
    slot.lastProcessed = processed;

    if (processed > 0) {
      orchestrator.gen += 1;
      slot.lastSeenGen = orchestrator.gen;
      // Wake any siblings that were idle-sleeping — our work may have
      // enqueued rows their pickers care about, and they should re-check
      // immediately rather than wait out the 5s poll.
      wakeAll(orchestrator);
      continue;
    }

    slot.lastSeenGen = orchestrator.gen;

    if (isFullyDrained(orchestrator)) {
      orchestrator.shutdown = true;
      wakeAll(orchestrator);
      break;
    }

    await sleepInterruptible(orchestrator, IDLE_POLL_MS);
  }
}

/** Drain criterion: every task has finished an iteration that (a) processed
 * nothing AND (b) observed the latest `gen` — i.e. nobody has done productive
 * work since each task's most recent idle iteration. Tasks currently mid-run
 * still hold the loop open. */
function isFullyDrained(orchestrator: Orchestrator): boolean {
  return Object.values(orchestrator.state).every(
    s =>
      !s.running && s.lastProcessed === 0 && s.lastSeenGen === orchestrator.gen
  );
}

/** True while any priority (view-job-detail/evaluate-skill-match) task is mid-iteration or its most
 * recent iteration processed work — i.e. more may still be queued. Deprioritized
 * tasks defer their next iteration until this goes false. The `running: true`
 * init sentinel makes this report busy until both priority tasks have completed
 * their first iteration, so upstream never races ahead at startup. */
function priorityTasksBusy(orchestrator: Orchestrator): boolean {
  return PRIORITY_TASKS.some(name => {
    const s = orchestrator.state[name];
    return s.running || s.lastProcessed > 0;
  });
}

function wakeAll(orchestrator: Orchestrator): void {
  for (const resolve of orchestrator.sleepers) resolve();
  orchestrator.sleepers.clear();
}

async function sleepInterruptible(
  orchestrator: Orchestrator,
  ms: number
): Promise<void> {
  await new Promise<void>(resolve => {
    const wake = () => {
      clearTimeout(timer);
      orchestrator.sleepers.delete(wake);
      resolve();
    };

    const timer = setTimeout(wake, ms);
    orchestrator.sleepers.add(wake);
  });
}
