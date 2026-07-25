import { sql, type ExpressionBuilder, type SqlBool } from 'kysely';

import type { DB } from '__generated__/db/types.js';
import { db, sqlite } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import {
  inScopeForEvaluate,
  inScopeForFillForm,
  inScopeForListing,
  inScopeForRunScripts,
  inScopeForScripting,
  inScopeForSourcing,
  inScopeForViewing,
} from 'src/db/pipelineQualified.js';
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
  | 'evaluate'
  | 'fill-form';

type PipelineFk =
  | 'ofSourceSeedId'
  | 'ofJobSourceId'
  | 'ofJobListSourceId'
  | 'ofJobPostId';

export const FK_BY_TASK: Record<PipelineTask, PipelineFk> = {
  seeding: 'ofSourceSeedId',
  sourcing: 'ofJobSourceId',
  listing: 'ofJobSourceId',
  scripting: 'ofJobListSourceId',
  'run-scripts': 'ofJobListSourceId',
  viewing: 'ofJobPostId',
  evaluate: 'ofJobPostId',
  'fill-form': 'ofJobPostId',
};

/** Pipeline order:
 *   seeding → sourcing → listing → scripting → run-scripts → viewing → evaluate
 *
 * `fill-form` is appended last. It keys on `ofJobPostId` like `viewing` and
 * `evaluate`, but it is an independent, human-triggered branch off a JobPost —
 * it reads the live application form rather than any column those stages write,
 * so it has no `TASK_PARENTS` entry and is not gated behind them.
 */
export const TASK_ORDER: readonly PipelineTask[] = [
  'seeding',
  'sourcing',
  'listing',
  'scripting',
  'run-scripts',
  'viewing',
  'evaluate',
  'fill-form',
];

/**
 * Hardcoded same-entity dependency tree. A task listed here must not be picked
 * up for an entity ROW while any of its parent tasks is still pending on the
 * SAME row (see `parentsSettledForPipelineTask`). Only tasks that share an FK
 * column belong here — cross-entity ordering (e.g. sourcing → listing across
 * different tables) is already enforced by the `qualifiedForX` / `inScopeForX`
 * data gates, so the dependency here is specifically for the case where a
 * parent's output column may already be populated from a prior run while a
 * fresh parent run is queued, and the child would otherwise race ahead against
 * stale data.
 *
 * The three consecutive same-FK pairs in `TASK_ORDER` are all gated here:
 *
 *   - `evaluate` ← `viewing` (both key on `ofJobPostId`): a re-queued `viewing`
 *     can coexist with a queued `evaluate` on the same JobPost, and without
 *     this gate `evaluate` would score the stale, about-to-be-overwritten
 *     `description` / `skillRequirements`.
 *   - `listing` ← `sourcing` (both key on `ofJobSourceId`): a re-queued
 *     `sourcing` overwrites `url` / `interestScore`, which `listing` reads as
 *     its qualified / in-scope gate; without the gate `listing` could crawl a
 *     stale URL that `sourcing` is about to replace.
 *   - `run-scripts` ← `scripting` (both key on `ofJobListSourceId`): a
 *     re-queued `scripting` overwrites `parserScript`, which `run-scripts`
 *     executes; without the gate `run-scripts` could run the old script.
 *
 * Each of these is a re-queue race (via `reset <stage>`, `--<entity>-id`, or
 * `--all`) that `start-pipeline`'s concurrent task loops expose. `seeding` is
 * the only task with no same-FK neighbour, so it has no entry.
 */
export const TASK_PARENTS: Partial<
  Record<PipelineTask, readonly PipelineTask[]>
> = {
  listing: ['sourcing'],
  'run-scripts': ['scripting'],
  evaluate: ['viewing'],
};

/** Config invariant: every declared parent must share the child's FK column,
 * so `parentsSettledForPipelineTask` can reuse the child's FK to look the
 * parent's state up on the same entity row. A cross-entity entry here is a
 * programming error — fail loudly at module load rather than silently generate
 * a mismatched subquery. */
export function assertTaskParentsSameEntity(
  taskParents: Partial<Record<PipelineTask, readonly PipelineTask[]>>,
  fkByTask: Record<PipelineTask, PipelineFk>
): void {
  for (const [child, parents] of Object.entries(taskParents)) {
    for (const parent of parents ?? []) {
      if (fkByTask[parent] !== fkByTask[child as PipelineTask]) {
        throw new Error(
          `TASK_PARENTS: ${child} → ${parent} is not a same-entity dependency ` +
            `(${fkByTask[child as PipelineTask]} vs ${fkByTask[parent]}).`
        );
      }
    }
  }
}

assertTaskParentsSameEntity(TASK_PARENTS, FK_BY_TASK);

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

/** Latest states that mean "needs pickup" by the next pipeline run. A crashed
 * process leaves its in-flight rows in `'started'`, NOT here — those are not
 * picked up directly (a live picker must never steal a row another process is
 * actively working). Orphaned `'started'` rows are reconciled to `'queued'` at
 * the start of the next run by `reapStaleStartedStates`, which then re-enters
 * this set. */
export const ELIGIBLE_FOR_PICKUP_STATES: ReadonlySet<string> = new Set([
  PIPELINE_STATE.QUEUED,
  PIPELINE_STATE.USER_INTERRUPTED,
]);

/** Parent states that keep a child task waiting (see `TASK_PARENTS` /
 * `parentsSettledForPipelineTask`): the parent is eligible for pickup
 * (`queued` / `user_interrupted`) or actively in flight (`started`). Every
 * terminal state — `done`, a no-result, or `failed` / `aborted` /
 * `script_error` — releases the child, at which point the child's own
 * qualified / inScope / state filters decide whether there is work to do. */
export const PARENT_PENDING_STATES: ReadonlySet<string> = new Set([
  ...ELIGIBLE_FOR_PICKUP_STATES,
  PIPELINE_STATE.STARTED,
]);

/** Latest states that mean "ran to a definite error". Targeted by
 * `jobfinder reset <stage> --failed`, which requeues these so the next
 * pipeline run retries them. */
export const FAILED_STATES: ReadonlySet<string> = new Set([
  PIPELINE_STATE.FAILED,
  PIPELINE_STATE.SCRIPT_ERROR,
  PIPELINE_STATE.ABORTED,
]);

/** Latest states that mean "ran but produced nothing to act on" — the genuine
 * no-result terminals. Targeted by `jobfinder reset <stage> --no-result`.
 * Excludes `user_interrupted` (already in `ELIGIBLE_FOR_PICKUP_STATES`, so it
 * is retried automatically without an explicit reset). */
export const NO_RESULT_STATES: ReadonlySet<string> = new Set([
  PIPELINE_STATE.NOT_A_JOB_POSTING,
  PIPELINE_STATE.NO_SOURCE_FOUND,
  PIPELINE_STATE.NO_LISTING_FOUND,
  PIPELINE_STATE.NO_RESULT_FOUND,
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

/** Tasks whose stale `'started'` rows have already been reaped this process, so
 * `reapStaleStartedStates` runs at most once per task per run. */
const reapedTasks = new Set<PipelineTask>();

/** Rebuild a `PipelineEntity` from the four nullable `of*Id` columns of a
 * PipelineState / LatestPipelineState row. Exactly one is non-null; returns
 * null only for a malformed row with none set. */
function pipelineEntityFromColumns(row: {
  ofSourceSeedId: string | null;
  ofJobSourceId: string | null;
  ofJobListSourceId: string | null;
  ofJobPostId: string | null;
}): PipelineEntity | null {
  if (row.ofSourceSeedId != null) return { ofSourceSeedId: row.ofSourceSeedId };
  if (row.ofJobSourceId != null) return { ofJobSourceId: row.ofJobSourceId };
  if (row.ofJobListSourceId != null) {
    return { ofJobListSourceId: row.ofJobListSourceId };
  }

  if (row.ofJobPostId != null) return { ofJobPostId: row.ofJobPostId };
  return null;
}

/** Reconcile orphaned `'started'` rows for `task` — the in-flight rows a
 * previous pipeline process left behind when it died without running its
 * SIGINT/SIGTERM handler (a SIGKILL, a power loss, or a hard crash, none of
 * which reach `flushInFlightAsInterrupted`). Only one pipeline process runs at
 * a time, so any entity whose latest state for `task` is `'started'` at the
 * moment a new run begins is by definition orphaned: no live process owns it.
 * We append a fresh `'queued'` row for each so the picker retries it and the
 * TUI stops drawing it as perpetually in-flight — the pipeline progress bar
 * counts `'started'` as pending, so a single orphan pins its stage below 100%
 * until the entity reaches a terminal state.
 *
 * Idempotent per process via `reapedTasks`. It MUST run before the run's first
 * `processOne` for `task`, so that it can only ever touch rows a prior process
 * left behind, never one this process is legitimately working. Returns the
 * number of entities requeued. */
export async function reapStaleStartedStates(
  task: PipelineTask
): Promise<number> {
  if (reapedTasks.has(task)) return 0;
  reapedTasks.add(task);

  const orphans = await db
    .selectFrom('LatestPipelineState')
    .select([
      'ofSourceSeedId',
      'ofJobSourceId',
      'ofJobListSourceId',
      'ofJobPostId',
    ])
    .where('task', '=', task)
    .where('state', '=', PIPELINE_STATE.STARTED)
    .execute();

  for (const orphan of orphans) {
    const entity = pipelineEntityFromColumns(orphan);
    if (entity == null) continue;

    await recordPipelineState({
      task,
      state: PIPELINE_STATE.QUEUED,
      reason: 'reaped: stale started row from a prior unclean exit',
      entity,
    });
  }

  if (orphans.length > 0) {
    terminal.log(
      `[${task}] reaped ${orphans.length} stale 'started' row(s) from a prior unclean exit; requeued for retry.`
    );
  }

  return orphans.length;
}

/** Tasks that operate on a pre-existing parent entity and can therefore be
 * requeued in bulk. `seeding` is excluded — it generates new SourceSeed rows
 * from interests/CV rather than picking up existing ones. */
export type RequeueableTask = Exclude<PipelineTask, 'seeding'>;

/** For `task`, insert a fresh 'queued' state for every parent entity that
 * passes `inScopeForX` (i.e. every row the pipeline considers in-scope,
 * including ones already done). For sourcing, every SourceSeed counts — see
 * `src/db/pipelineQualified.ts` for the qualified-vs-inscope distinction
 * with worked examples.
 *
 * This is the `--all` knob: explicit, force-everything-onto-the-queue. Rows
 * already `queued`/`started`/`user_interrupted` are requeued anyway (the
 * LatestPipelineState view keys off createdAt, so the new queued row wins).
 * The paired runner switch (picker uses inScopeForX under --all) ensures the
 * runner actually processes the requeued rows even if they're past their
 * task's "qualified" gate.
 *
 * Returns the number of entities requeued. */
export async function requeueAllInScope(
  task: RequeueableTask
): Promise<number> {
  const ids = await (async (): Promise<string[]> => {
    switch (task) {
      case 'sourcing': {
        const rows = await db
          .selectFrom('JobSource')
          .select('JobSource.id as id')
          .where(inScopeForSourcing)
          .execute();

        return rows.map(r => r.id);
      }

      case 'listing': {
        const rows = await db
          .selectFrom('JobSource')
          .select('JobSource.id as id')
          .where(inScopeForListing)
          .execute();

        return rows.map(r => r.id);
      }

      case 'scripting': {
        const rows = await db
          .selectFrom('JobListSource')
          .select('JobListSource.id as id')
          .where(inScopeForScripting)
          .execute();

        return rows.map(r => r.id);
      }

      case 'run-scripts': {
        const rows = await db
          .selectFrom('JobListSource')
          .select('JobListSource.id as id')
          .where(inScopeForRunScripts)
          .execute();

        return rows.map(r => r.id);
      }

      case 'viewing': {
        const rows = await db
          .selectFrom('JobPost')
          .select('JobPost.id as id')
          .where(inScopeForViewing)
          .execute();

        return rows.map(r => r.id);
      }

      case 'evaluate': {
        const rows = await db
          .selectFrom('JobPost')
          .select('JobPost.id as id')
          .where(inScopeForEvaluate)
          .execute();

        return rows.map(r => r.id);
      }

      case 'fill-form': {
        const rows = await db
          .selectFrom('JobPost')
          .select('JobPost.id as id')
          .where(inScopeForFillForm)
          .execute();

        return rows.map(r => r.id);
      }
    }
  })();

  const fk = FK_BY_TASK[task];
  for (const id of ids) {
    await enqueuePipelineTask({
      task,
      entity: { [fk]: id } as PipelineEntity,
    });
  }

  if (ids.length === 0) {
    terminal.log(`--all: nothing to requeue for ${task} (no in-scope rows).`);
  } else {
    terminal.log(`--all: requeued ${ids.length} in-scope rows for ${task}.`);
  }

  return ids.length;
}

/** Requeue every parent entity whose CURRENT (latest) pipeline state for
 * `task` is one of `states` — i.e. insert a fresh 'queued' row so the next
 * run for `task` re-picks it. Unlike `requeueAllInScope`, this keys off the
 * `LatestPipelineState` view rather than the in-scope predicate, so it only
 * touches rows that actually reached one of the given states. Backs
 * `jobfinder reset <stage> --failed` and `--no-result`.
 *
 * Returns the number of entities requeued. */
export async function requeueByLatestState(
  task: RequeueableTask,
  states: ReadonlySet<string>
): Promise<number> {
  const fk = FK_BY_TASK[task];
  // `fk` is one of the four `of*Id` columns; TS can't narrow it through
  // `FK_BY_TASK`, so cast to a single concrete column name for the query
  // builder. Runtime SQL is unaffected — same cast pattern as
  // `eligibleForPipelineTask`. The RETURNED rows keep `fk`'s real column
  // name as their key, so we must read the value back by `fk`, not by the
  // casted name.
  const fkCol = fk as 'ofJobSourceId';
  const rows = await db
    .selectFrom('LatestPipelineState')
    .select(fkCol)
    .where('task', '=', task)
    .where('state', 'in', [...states])
    .where(fkCol, 'is not', null)
    .execute();

  const ids = rows
    .map(r => (r as Record<string, string | null>)[fk])
    .filter((id): id is string => id != null);

  for (const id of ids) {
    await enqueuePipelineTask({
      task,
      entity: { [fk]: id } as PipelineEntity,
    });
  }

  return ids.length;
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
 * is eligible for pickup (state in 'queued' or 'user_interrupted'). Rows a
 * crashed run left in 'started' are NOT matched here — `reapStaleStartedStates`
 * requeues them to 'queued' at the start of the next run so they land in this
 * set without a live picker ever stealing an actively-processing row.
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

/** Predicate for use in `WHERE` clauses to filter to parent-entity rows
 * whose latest pipeline state for `args.task` is NOT a terminal-success
 * state. Used by `--include-failed`: pulls in queued, started,
 * user_interrupted, no_result, failed, aborted, script_error — anything
 * that isn't `done`. Rows with no `LatestPipelineState` row for the task
 * are also counted as "not done". */
export function notDoneForPipelineTask<
  P extends 'SourceSeed' | 'JobSource' | 'JobListSource' | 'JobPost',
>(args: { task: PipelineTask; parentIdRef: `${P}.id` }) {
  const fk = FK_BY_TASK[args.task];
  return (eb: ExpressionBuilder<DB, P>) => {
    // Same TS narrowing escape hatch as `eligibleForPipelineTask`.
    const ebConcrete = eb as unknown as ExpressionBuilder<DB, 'JobSource'>;
    return ebConcrete.not(
      ebConcrete.exists(
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
            ...TERMINAL_SUCCESS_STATES,
          ])
      )
    );
  };
}

/** For each task that appears as a PARENT in `TASK_PARENTS`, the `inScopeForX`
 * predicate used to decide whether a pending parent row genuinely blocks its
 * children. A parent whose row is out of scope for the parent task will never
 * be picked by that task's own picker, so a stale `queued` row on an
 * out-of-scope parent must NOT pin the child forever — see
 * `parentsSettledForPipelineTask`. Keyed by parent task; extend alongside
 * `TASK_PARENTS`. The predicate runs over the CHILD's parent table, which by
 * the same-entity invariant is also the parent task's table — so each entry is
 * cast to the erased signature `parentsSettledForPipelineTask` invokes it with
 * (the same runtime-safe narrowing escape hatch used across this file). */
type ParentScopePredicate = (eb: ExpressionBuilder<DB, 'JobPost'>) => unknown;
const PARENT_SCOPE_BY_TASK: Partial<
  Record<PipelineTask, ParentScopePredicate>
> = {
  sourcing: inScopeForSourcing as unknown as ParentScopePredicate,
  scripting: inScopeForScripting as unknown as ParentScopePredicate,
  viewing: inScopeForViewing,
};

/**
 * Where-predicate factory: rows of `P` for which NO parent task (per
 * `TASK_PARENTS`) is still pending on the same row. AND this into the child's
 * picker alongside its existing `qualifiedForX ∩ inScopeForX` + state filter.
 * Trivially true (`1`) for a task with no declared parents.
 *
 * A parent blocks the child only when BOTH its latest state is in
 * `PARENT_PENDING_STATES` AND the row is in scope for the parent task. The
 * in-scope conjunct keeps a force-queued but out-of-scope parent — which the
 * parent's own picker will never touch — from pinning the child forever. This
 * matters only for a pair whose child scope is NOT a subset of the parent
 * scope. For all three current linear-pipeline pairs (evaluate ← viewing,
 * listing ← sourcing, run-scripts ← scripting) the child's `inScopeForX`
 * already AND-embeds the parent's, so the conjunct is redundant-but-safe there;
 * it is kept so the generic mechanism stays correct for any future non-subset
 * pair.
 *
 * Example:
 *   db.selectFrom('JobPost').where(parentsSettledForPipelineTask({
 *     task: 'evaluate', parentIdRef: 'JobPost.id',
 *   }))
 */
export function parentsSettledForPipelineTask<
  P extends 'SourceSeed' | 'JobSource' | 'JobListSource' | 'JobPost',
>(args: { task: PipelineTask; parentIdRef: `${P}.id` }) {
  const parents = TASK_PARENTS[args.task] ?? [];
  const fk = FK_BY_TASK[args.task];
  return (eb: ExpressionBuilder<DB, P>) => {
    if (parents.length === 0) return sql<SqlBool>`1`;
    // Same TS narrowing escape hatch as `eligibleForPipelineTask`: the runtime
    // FK column is one of the four `of*Id` columns, and (by the same-entity
    // invariant) the parent scope predicate runs over the child's own table.
    const ebConcrete = eb as unknown as ExpressionBuilder<DB, 'JobPost'>;
    return ebConcrete.and(
      parents.map(parent => {
        const parentPending = ebConcrete.exists(
          ebConcrete
            .selectFrom('LatestPipelineState')
            .select('LatestPipelineState.id')
            .whereRef(
              `LatestPipelineState.${fk}` as 'LatestPipelineState.ofJobPostId',
              '=',
              args.parentIdRef as 'JobPost.id'
            )
            .where('LatestPipelineState.task', '=', parent)
            .where('LatestPipelineState.state', 'in', [
              ...PARENT_PENDING_STATES,
            ])
        );

        const parentInScope = PARENT_SCOPE_BY_TASK[parent];
        const blocks = parentInScope
          ? ebConcrete.and([
              parentPending,
              parentInScope(ebConcrete) as typeof parentPending,
            ])
          : parentPending;

        return ebConcrete.not(blocks);
      })
    );
  };
}

/** The three CLI modes each pipeline command supports. The mode picks the
 * state filter layered on top of `qualifiedForX ∩ inScopeForX`.
 *
 * - `queued-only` (default, no flag): pick rows whose latest state is in
 *   `ELIGIBLE_FOR_PICKUP_STATES` (queued / user_interrupted). Bar can reach
 *   100% if upstream enqueues correctly.
 * - `include-failed` (--include-failed): pick anything not done — relaxes
 *   the queued filter to also retry failed/aborted/no_result/etc.
 * - `all` (--all): no state filter. Re-process every qualifying in-scope
 *   row, including done ones. Call `requeueAllInScope(task)` first so the
 *   requeued rows show as pending in the TUI while they're being re-run. */
export type PipelineMode = 'queued-only' | 'include-failed' | 'all';

export function pipelineModeFromOptions(opts: {
  all?: boolean;
  includeFailed?: boolean;
}): PipelineMode {
  if (opts.all && opts.includeFailed) {
    throw new Error(
      'Cannot combine --all and --include-failed; pick one (--all is the superset).'
    );
  }

  if (opts.all) return 'all';
  if (opts.includeFailed) return 'include-failed';
  return 'queued-only';
}

/** Picker state filter for a given mode. Returns `null` for `all` — caller
 * should omit the `.where()` (i.e., no state filter). */
export function pickerStateFilter<
  P extends 'SourceSeed' | 'JobSource' | 'JobListSource' | 'JobPost',
>(args: {
  task: PipelineTask;
  parentIdRef: `${P}.id`;
  mode: PipelineMode;
}): ReturnType<typeof eligibleForPipelineTask<P>> | null {
  switch (args.mode) {
    case 'queued-only':
      return eligibleForPipelineTask({
        task: args.task,
        parentIdRef: args.parentIdRef,
      });
    case 'include-failed':
      return notDoneForPipelineTask({
        task: args.task,
        parentIdRef: args.parentIdRef,
      });
    case 'all':
      return null;
  }
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
  // Signal-driven exits — flush in-flight rows as `user_interrupted` then
  // exit. `process.once` so a second Ctrl+C reverts to Node's default kill.
  process.once('SIGINT', () => handleInterrupt(130));
  process.once('SIGTERM', () => handleInterrupt(143));

  // Detached rejections / synchronous throws from outside our await chains
  // (e.g. the OpenRouter SDK's APIPromise wrapper forks $do() into two
  // promise chains and only the awaited one is observed — the sibling
  // chain's rejection surfaces here even though our retry loop already
  // handled the real error). Log loudly and keep the loop running; rows
  // are still processed to a definite outcome by their own await chains.
  process.on('unhandledRejection', err => {
    const e = err as { stack?: string } | undefined;

    terminal.warn(
      `unhandledRejection (continuing): ${e?.stack ?? String(err)}`
    );
  });

  process.on('uncaughtException', err => {
    terminal.warn(`uncaughtException (continuing): ${err.stack ?? err}`);
  });
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
