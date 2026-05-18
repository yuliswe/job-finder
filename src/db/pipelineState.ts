import type { ExpressionBuilder } from 'kysely';

import type { DB } from '__generated__/db/types.js';
import { db, sqlite } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import { terminal } from 'src/utils/terminal.js';

export type PipelineEntity =
  | { ofSourceSeedId: string }
  | { ofJobSourceId: string }
  | { ofJobListSourceId: string }
  | { ofJobPostId: string };

export type PipelineTask =
  | 'seeding'
  | 'sourcing'
  | 'listing'
  | 'scripting'
  | 'run-scripts'
  | 'viewing'
  | 'evaluate';

type PipelineFk =
  | 'ofSourceSeedId'
  | 'ofJobSourceId'
  | 'ofJobListSourceId'
  | 'ofJobPostId';

export const FK_BY_TASK: Record<PipelineTask, PipelineFk> = {
  seeding: 'ofSourceSeedId',
  sourcing: 'ofSourceSeedId',
  listing: 'ofJobSourceId',
  scripting: 'ofJobListSourceId',
  'run-scripts': 'ofJobListSourceId',
  viewing: 'ofJobPostId',
  evaluate: 'ofJobPostId',
};

/** Pipeline order:
 *   seeding → sourcing → listing → scripting → run-scripts → viewing → evaluate
 */
export const TASK_ORDER: readonly PipelineTask[] = [
  'seeding',
  'sourcing',
  'listing',
  'scripting',
  'run-scripts',
  'viewing',
  'evaluate',
];

/** Canonical state values written to `PipelineState.state`. The column is a
 * plain `text` and accepts arbitrary strings — these are the names every
 * pipeline command should use. */
export const PIPELINE_STATE = {
  QUEUED: 'queued',
  STARTED: 'started',
  DONE: 'done',
  FAILED: 'failed',
  CREATED: 'created',
  NOT_A_JOB_POSTING: 'not_a_job_posting',
  NO_SOURCE_FOUND: 'no_source_found',
  NO_LISTING_FOUND: 'no_listing_found',
  NO_RESULT_FOUND: 'no_result_found',
  SCRIPT_ERROR: 'script_error',
  ABORTED: 'aborted',
  /** Written by the SIGINT/SIGTERM handler for entities still in `'started'`
   * when the CLI is killed. Terminal: not eligible for re-pickup. */
  USER_INTERRUPTED: 'user_interrupted',
} as const;

/** Latest states that mean "completed successfully with a result" — the
 * downstream pipeline has something concrete to act on. */
export const TERMINAL_SUCCESS_STATES: ReadonlySet<string> = new Set([
  PIPELINE_STATE.DONE,
]);

/** Latest states that mean "ran successfully but produced no result" — not an
 * error, just nothing to do downstream (e.g. URL was not a job posting, source
 * page had no listings). The entity is terminal: not re-picked. */
export const TERMINAL_NO_RESULT_STATES: ReadonlySet<string> = new Set([
  PIPELINE_STATE.NOT_A_JOB_POSTING,
  PIPELINE_STATE.NO_SOURCE_FOUND,
  PIPELINE_STATE.NO_LISTING_FOUND,
  PIPELINE_STATE.NO_RESULT_FOUND,
  PIPELINE_STATE.USER_INTERRUPTED,
]);

/** Latest states that mean "needs pickup" by the next pipeline run. Includes
 * `'started'` so a process that crashed mid-work is retried automatically. */
export const ELIGIBLE_FOR_PICKUP_STATES: ReadonlySet<string> = new Set([
  PIPELINE_STATE.QUEUED,
  PIPELINE_STATE.USER_INTERRUPTED,
]);

/**
 * Append a row to `PipelineState` recording that `task` touched `entity` and
 * left it in `state`. The latest row per (task, entity) — found via
 * `ORDER BY createdAt DESC LIMIT 1` — is the current status, also exposed via
 * the `LatestPipelineState` view.
 */
export async function recordPipelineState(args: {
  task: PipelineTask;
  state: string;
  entity: PipelineEntity;
  reason?: string | null;
}): Promise<void> {
  await db
    .insertInto('PipelineState')
    .values({
      id: newId(),
      task: args.task,
      state: args.state,
      reason: args.reason ?? null,
      ofSourceSeedId: null,
      ofJobSourceId: null,
      ofJobListSourceId: null,
      ofJobPostId: null,
      ...args.entity,
    })
    .execute();
}

/** Insert a 'queued' PipelineState row for (task, entity). The next pipeline
 * run for `task` will pick this entity up. Safe to call repeatedly — only the
 * latest row matters. */
export async function enqueuePipelineTask(args: {
  task: PipelineTask;
  entity: PipelineEntity;
}): Promise<void> {
  await recordPipelineState({
    task: args.task,
    state: PIPELINE_STATE.QUEUED,
    entity: args.entity,
  });
}

/** Returns the latest `PipelineState` row for (task, entity) via the
 * `LatestPipelineState` view, or null if no row exists. */
export async function getLatestPipelineState(args: {
  task: PipelineTask;
  entity: PipelineEntity;
}): Promise<{ state: string; createdAt: string } | null> {
  const fk = FK_BY_TASK[args.task];
  const entityId = entityIdOf(args.entity);
  const row = await db
    .selectFrom('LatestPipelineState')
    .select(['state', 'createdAt'])
    .where('task', '=', args.task)
    .where(fk, '=', entityId)
    .executeTakeFirst();
  // View columns are typed as nullable by kysely-codegen, but rows in this
  // view are derived from non-null `PipelineState` columns — narrow here.
  if (row == null || row.state == null || row.createdAt == null) return null;
  return { state: row.state, createdAt: row.createdAt };
}

/** True iff the latest state for (task, entity) is terminal-completed
 * (success OR no-result) — the entity is not eligible for re-pickup. */
export async function isPipelineTaskDone(args: {
  task: PipelineTask;
  entity: PipelineEntity;
}): Promise<boolean> {
  const row = await getLatestPipelineState(args);
  if (row == null) return false;
  return (
    TERMINAL_SUCCESS_STATES.has(row.state) ||
    TERMINAL_NO_RESULT_STATES.has(row.state)
  );
}

/**
 * Where-predicate factory: rows of `P` whose latest `PipelineState` for `task`
 * is eligible for pickup (state in 'queued' or 'started'). `'started'` is
 * included so a process that crashed mid-work is retried on the next run.
 *
 * Example:
 *   db.selectFrom('JobSource').where(eligibleForPipelineTask({
 *     task: 'listing', parentIdRef: 'JobSource.id',
 *   }))
 */
export function eligibleForPipelineTask<
  P extends 'SourceSeed' | 'JobSource' | 'JobListSource' | 'JobPost',
>(args: { task: PipelineTask; parentIdRef: `${P}.id` }) {
  const fk = FK_BY_TASK[args.task];
  return (eb: ExpressionBuilder<DB, P>) => {
    // The runtime FK column name is one of the four `of*Id` columns. TS
    // can't narrow it statically through `FK_BY_TASK`, so we cast the EB to
    // a single concrete scope; runtime SQL is unaffected.
    const ebConcrete = eb as unknown as ExpressionBuilder<DB, 'JobSource'>;
    return ebConcrete.exists(
      ebConcrete
        .selectFrom('LatestPipelineState')
        .select('LatestPipelineState.id')
        .whereRef(
          `LatestPipelineState.${fk}` as 'LatestPipelineState.ofJobSourceId',
          '=',
          args.parentIdRef as 'JobSource.id'
        )
        .where('LatestPipelineState.task', '=', args.task)
        .where('LatestPipelineState.state', 'in', [
          ...ELIGIBLE_FOR_PICKUP_STATES,
        ])
    );
  };
}

function entityIdOf(entity: PipelineEntity): string {
  if ('ofSourceSeedId' in entity) return entity.ofSourceSeedId;
  if ('ofJobSourceId' in entity) return entity.ofJobSourceId;
  if ('ofJobListSourceId' in entity) return entity.ofJobListSourceId;
  return entity.ofJobPostId;
}

/**
 * Run one record's worth of work, bracketed by `started`/`failed` state
 * recording. Per-command files wrap their per-record helpers around this so
 * thrown errors uniformly mark the record failed.
 *
 * On SIGINT/SIGTERM, any entity still inside `processOne` has a
 * `'user_interrupted'` row written synchronously before the process exits,
 * so the bar never gets stuck pulsing across runs.
 *
 * Returns `work`'s result on success, or `undefined` on caught error.
 */
export async function processOne<T>(args: {
  task: PipelineTask;
  entity: PipelineEntity;
  work: () => Promise<T>;
  /** Short label (URL, name, id) included in the error log on failure. */
  label?: string;
}): Promise<T | undefined> {
  installInterruptHandlers();
  const entry: InFlight = {
    task: args.task,
    fk: FK_BY_TASK[args.task],
    entityId: entityIdOf(args.entity),
  };
  inFlight.add(entry);
  await recordPipelineState({
    task: args.task,
    state: PIPELINE_STATE.STARTED,
    entity: args.entity,
  });
  try {
    return await args.work();
  } catch (err) {
    terminal.error(
      `${args.task} failed${args.label ? ` for ${args.label}` : ''}: ${String(err)}`
    );
    await recordPipelineState({
      task: args.task,
      state: PIPELINE_STATE.FAILED,
      reason: String(err).slice(0, 500),
      entity: args.entity,
    });
    return undefined;
  } finally {
    inFlight.delete(entry);
  }
}

// In-flight tracker: every entity currently inside a processOne call. The
// signal handlers iterate this set and write a `'user_interrupted'` row for
// each before the process exits. Synchronous so we don't lose anything to
// pending microtasks when Node tears down.

type InFlight = {
  task: PipelineTask;
  fk: PipelineFk;
  entityId: string;
};

const inFlight = new Set<InFlight>();

let interruptHandlersInstalled = false;

function installInterruptHandlers(): void {
  if (interruptHandlersInstalled) return;
  interruptHandlersInstalled = true;
  // Use `process.once` so a second Ctrl+C kills immediately.
  process.once('SIGINT', () => handleInterrupt(130));
  process.once('SIGTERM', () => handleInterrupt(143));
}

function handleInterrupt(exitCode: number): void {
  flushInFlightAsInterrupted();
  process.exit(exitCode);
}

function flushInFlightAsInterrupted(): void {
  if (inFlight.size === 0) return;
  const stmt = sqlite.prepare(
    `INSERT INTO PipelineState
       (id, task, state, reason,
        ofSourceSeedId, ofJobSourceId, ofJobListSourceId, ofJobPostId)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`
  );
  for (const e of inFlight) {
    stmt.run(
      newId(),
      e.task,
      PIPELINE_STATE.USER_INTERRUPTED,
      e.fk === 'ofSourceSeedId' ? e.entityId : null,
      e.fk === 'ofJobSourceId' ? e.entityId : null,
      e.fk === 'ofJobListSourceId' ? e.entityId : null,
      e.fk === 'ofJobPostId' ? e.entityId : null
    );
  }
  inFlight.clear();
}
