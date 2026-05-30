import { Command } from 'commander';
import type { BrowserContext } from 'patchright';

import { runEvaluate } from 'src/cli/commands/pipeline/evaluate.js';
import { runListing } from 'src/cli/commands/pipeline/listing.js';
import { runRunScripts } from 'src/cli/commands/pipeline/run-scripts.js';
import { runScripting } from 'src/cli/commands/pipeline/scripting.js';
import { runSourcing } from 'src/cli/commands/pipeline/sourcing.js';
import { runViewing } from 'src/cli/commands/pipeline/viewing.js';
import { withBrowserInstance } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';

/** Idle-poll interval applied only when a task's previous iteration found
 * nothing to do. Iterations that processed >0 items re-loop immediately. */
const IDLE_POLL_MS = 5_000;

type TaskName =
  | 'sourcing'
  | 'listing'
  | 'scripting'
  | 'run-scripts'
  | 'viewing'
  | 'evaluate';

const TASKS: readonly TaskName[] = [
  'sourcing',
  'listing',
  'scripting',
  'run-scripts',
  'viewing',
  'evaluate',
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

export function createRunPipelineCommand(): Command {
  return new Command('run-pipeline')
    .description(
      'Run sourcing, listing, scripting, run-scripts, viewing, and evaluate concurrently in independent loops until every queue drains. Each loop sleeps 5s only when its previous iteration found nothing to do.'
    )
    .action(runAllLoops);
}

async function runAllLoops(): Promise<void> {
  // `running: true` at init is a "not yet completed first iteration" sentinel.
  // Without it, a fast no-browser task (evaluate) can finish its first
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
    `Starting run-pipeline orchestrator: ${TASKS.length} tasks, idle poll = ${IDLE_POLL_MS / 1000}s`
  );

  await Promise.all([
    runLoopWithBrowser(orchestrator, 'sourcing', ctx => runSourcing(ctx, {})),
    runLoopWithBrowser(orchestrator, 'listing', ctx => runListing(ctx, {})),
    runLoopWithBrowser(orchestrator, 'scripting', ctx => runScripting(ctx, {})),
    runLoopWithBrowser(orchestrator, 'run-scripts', ctx =>
      runRunScripts(ctx, {})
    ),
    runLoopWithBrowser(orchestrator, 'viewing', ctx => runViewing(ctx, {})),
    runLoop(orchestrator, 'evaluate', () => runEvaluate({})),
  ]);

  terminal.log('All pipeline tasks drained. Shutting down.');
}

async function runLoopWithBrowser(
  orchestrator: Orchestrator,
  name: TaskName,
  fn: (ctx: BrowserContext) => Promise<{ processed: number }>
): Promise<void> {
  await withBrowserInstance(context =>
    runLoop(orchestrator, name, () => fn(context))
  );
}

async function runLoop(
  orchestrator: Orchestrator,
  name: TaskName,
  fn: () => Promise<{ processed: number }>
): Promise<void> {
  const slot = orchestrator.state[name];

  while (!orchestrator.shutdown) {
    slot.running = true;
    let processed = 0;
    try {
      ({ processed } = await fn());
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
