import { sql } from 'kysely';

import { PIPELINE_VIEWING_MIN_TITLE_RELEVANCY } from 'jobfinder.config.js';
import { jobPostInActiveSource } from 'src/db/activeSource.js';
import { Bool } from 'src/db/customTypes.js';
import { db } from 'src/db/index.js';
import {
  PIPELINE_STATE,
  type PipelineTask,
  TASK_ORDER,
  TERMINAL_NO_RESULT_STATES,
  TERMINAL_SUCCESS_STATES,
} from 'src/db/pipelineState.js';
import {
  inScopeForEvaluate,
  inScopeForListing,
  inScopeForRunScripts,
  inScopeForScripting,
  inScopeForViewing,
} from 'src/db/pipelineQualified.js';
import type { SkillBreakdownEntry } from 'src/llm/evaluateJobPost.js';
import type { SkillRequirements } from 'src/llm/viewJobPost.js';
import { bumpLocalRevision } from 'src/tui/useLiveData.js';

export type PipelineStageStats = {
  task:
    | 'seeding'
    | 'sourcing'
    | 'listing'
    | 'scripting'
    | 'run-scripts'
    | 'viewing'
    | 'evaluate';
  /** Parent-table rows we deliberately skip (inactive tree, below relevancy
   * threshold). Not drawn in the bar; surfaced in the count summary text. */
  outOfScope: number;
  /** In-scope; latest state is a terminal-success value with a result. */
  done: number;
  /** In-scope; latest state is terminal-completed but produced no result
   * (not_a_job_posting, no_*_found). */
  noResult: number;
  /** In-scope; latest state is a terminal failure (failed, aborted,
   * script_error, etc.). */
  failed: number;
  /** In-scope; latest state is queued OR no LatestPipelineState row exists
   * for this task yet (not-yet-enqueued counts as pending). */
  queued: number;
  /** In-scope; latest state is started — actively being processed (or left
   * over from a crashed run). */
  started: number;
  /** outOfScope + done + noResult + failed + queued + started — equals the
   * parent table's row count. */
  total: number;
  label: string;
};

export type JobPostRow = {
  id: string;
  title: string;
  url: string;
  company: string | null;
  location: string | null;
  isRemote: number | null;
  postedAt: string | null;
  /** Where `postedAt` came from. `'job_post'` = LLM read it from the page
   * itself (exact). `'twbm'` = filled from the Wayback Machine's earliest
   * snapshot (lower bound only). null when no postedAt exists. */
  postedAtSource: 'job_post' | 'twbm' | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  titleRelavency: number | null;
  titleRelavencyReason: string | null;
  interestScore: number | null;
  interestScoreReason: string | null;
  skillScore: number | null;
  skillScoreReason: string | null;
  /** Parsed from the JSON-encoded JobPostEval.skillScoreBreakdown column. */
  skillScoreBreakdown: SkillBreakdownEntry[] | null;
  /** Parsed from JobPost.skillRequirements — posting-derived only (no CV). */
  skillRequirements: SkillRequirements | null;
  overallScore: number | null;
  description: string | null;
  summary: string | null;
};

export type SourceRow = {
  /** Composite of source + list id, stable for React keys. */
  rowKey: string;
  /** `'source'` for JobSource-backed rows; `'seed'` for SourceSeed rows whose
   * sourcing hasn't yet landed a JobSource. Seed rows are display-only — not
   * toggleable, no list, no posts. */
  kind: 'source' | 'seed';
  sourceId: string;
  sourceName: string;
  sourceUrl: string;
  sourceIsActive: number;
  sourceIsProcessed: number;
  listId: string | null;
  listUrl: string | null;
  listIsActive: number | null;
  listIsProcessed: number | null;
  listLocations: string | null;
  listDivisions: string | null;
  hasScript: number;
  jobPostCount: number;
  /** Effective active flag — JobListSource's when present, else JobSource's.
   * `null` for `kind === 'seed'`, where the concept doesn't apply. */
  isActive: number | null;
};

export type ActivityRow = {
  task: string;
  state: string;
  reason: string | null;
  createdAt: string;
  entity: string;
};

export type JobPostSortKey = 'overall' | 'interest' | 'skill';

export async function getPipelineStats(): Promise<PipelineStageStats[]> {
  // Each bar's denominator is its parent table's row count (e.g., scripting →
  // every JobListSource). Parent rows partition into 5 buckets:
  //   outOfScope = fails `inScopeForX` (deliberately skipped — inactive tree,
  //                below relevancy threshold);
  //   done / noResult / failed = in-scope; bucketed by latest pipeline state;
  //   queued = in-scope; latest state is queued/started/user_interrupted, OR
  //            no LatestPipelineState row exists yet (not-yet-enqueued).
  return Promise.all(TASK_ORDER.map(stageStats));
}

type RawBucket = { inScope: number; state: string | null; n: number };

async function stageStats(task: PipelineTask): Promise<PipelineStageStats> {
  const buckets = await stageRawBuckets(task);

  let outOfScope = 0;
  let done = 0;
  let noResult = 0;
  let failed = 0;
  let queued = 0;
  let started = 0;
  for (const b of buckets) {
    const n = Number(b.n ?? 0);
    if (b.inScope === 0) {
      outOfScope += n;
      continue;
    }

    if (b.state == null) {
      queued += n;
      continue;
    }

    // user_interrupted is terminal in the data model (won't be auto-re-picked)
    // but the TUI buckets it under `queued` so it shows as pending in the bar
    // rather than a yellow "no-result" — a Ctrl+C is not really an outcome.
    if (b.state === PIPELINE_STATE.USER_INTERRUPTED) queued += n;
    else if (TERMINAL_SUCCESS_STATES.has(b.state)) done += n;
    else if (TERMINAL_NO_RESULT_STATES.has(b.state)) noResult += n;
    else if (b.state === PIPELINE_STATE.QUEUED) queued += n;
    else if (b.state === PIPELINE_STATE.STARTED) started += n;
    else failed += n;
  }

  return {
    task,
    label: task,
    outOfScope,
    done,
    noResult,
    failed,
    queued,
    started,
    total: outOfScope + done + noResult + failed + queued + started,
  };
}

async function stageRawBuckets(task: PipelineTask): Promise<RawBucket[]> {
  // Each branch starts from the parent table and LEFT JOINs LatestPipelineState
  // so rows that haven't been enqueued yet (no state row) are still counted.
  // The `inScope` CASE expression separates rows we'd ever process from rows
  // we deliberately skip; rows are grouped by (inScope, state) and counted.
  switch (task) {
    case 'seeding':
    case 'sourcing':
      // Every SourceSeed is in scope — no skip rule.
      return db
        .selectFrom('SourceSeed')
        .leftJoin('LatestPipelineState', join =>
          join
            .onRef('LatestPipelineState.ofSourceSeedId', '=', 'SourceSeed.id')
            .on('LatestPipelineState.task', '=', task)
        )
        .select(eb => [
          sql<number>`1`.as('inScope'),
          eb.ref('LatestPipelineState.state').as('state'),
          eb.fn.countAll<number>().as('n'),
        ])
        .groupBy(['LatestPipelineState.state'])
        .execute();
    case 'listing':
      return db
        .selectFrom('JobSource')
        .leftJoin('LatestPipelineState', join =>
          join
            .onRef('LatestPipelineState.ofJobSourceId', '=', 'JobSource.id')
            .on('LatestPipelineState.task', '=', task)
        )
        .select(eb => [
          eb
            .case()
            .when(inScopeForListing(eb))
            .then(1)
            .else(0)
            .end()
            .as('inScope'),
          eb.ref('LatestPipelineState.state').as('state'),
          eb.fn.countAll<number>().as('n'),
        ])
        .groupBy([sql`"inScope"`, 'LatestPipelineState.state'])
        .execute();
    case 'scripting':
    case 'run-scripts':
      return db
        .selectFrom('JobListSource')
        .leftJoin('LatestPipelineState', join =>
          join
            .onRef(
              'LatestPipelineState.ofJobListSourceId',
              '=',
              'JobListSource.id'
            )
            .on('LatestPipelineState.task', '=', task)
        )
        .select(eb => [
          eb
            .case()
            .when(
              task === 'scripting'
                ? inScopeForScripting(eb)
                : inScopeForRunScripts(eb)
            )
            .then(1)
            .else(0)
            .end()
            .as('inScope'),
          eb.ref('LatestPipelineState.state').as('state'),
          eb.fn.countAll<number>().as('n'),
        ])
        .groupBy([sql`"inScope"`, 'LatestPipelineState.state'])
        .execute();
    case 'viewing':
    case 'evaluate':
      return db
        .selectFrom('JobPost')
        .leftJoin('LatestPipelineState', join =>
          join
            .onRef('LatestPipelineState.ofJobPostId', '=', 'JobPost.id')
            .on('LatestPipelineState.task', '=', task)
        )
        .select(eb => [
          eb
            .case()
            .when(
              task === 'viewing'
                ? inScopeForViewing(eb)
                : inScopeForEvaluate(eb)
            )
            .then(1)
            .else(0)
            .end()
            .as('inScope'),
          eb.ref('LatestPipelineState.state').as('state'),
          eb.fn.countAll<number>().as('n'),
        ])
        .groupBy([sql`"inScope"`, 'LatestPipelineState.state'])
        .execute();
  }
}

export async function listJobPosts(args: {
  sort: JobPostSortKey;
  limit?: number;
  /** If set, only return JobPosts belonging to this JobSource. Used by the
   * source-jobs screen. */
  ofJobSourceId?: string;
  /** If true, only return JobPosts that pass `inScopeForViewing` — i.e. that
   * cleared the relevancy threshold and are in an active source tree. Matches
   * the per-source count shown in the Sources list. */
  inScopeOnly?: boolean;
}): Promise<JobPostRow[]> {
  const { sort, limit = 500, ofJobSourceId, inScopeOnly = false } = args;

  let base = db
    .selectFrom('JobPost')
    .leftJoin('JobPostEval', 'JobPostEval.ofJobPostId', 'JobPost.id')
    .where(jobPostInActiveSource);

  if (ofJobSourceId) {
    base = base.where('JobPost.ofJobSourceId', '=', ofJobSourceId);
  }

  if (inScopeOnly) {
    base = base.where(inScopeForViewing);
  }

  let q = base.select([
    'JobPost.id as id',
    'JobPost.title as title',
    'JobPost.url as url',
    'JobPost.company as company',
    'JobPost.location as location',
    'JobPost.isRemote as isRemote',
    'JobPost.postedAt as postedAt',
    'JobPost.postedAtSource as postedAtSource',
    'JobPost.salaryMin as salaryMin',
    'JobPost.salaryMax as salaryMax',
    'JobPost.salaryCurrency as salaryCurrency',
    'JobPost.description as description',
    'JobPost.summary as summary',
    'JobPost.skillRequirements as skillRequirementsJson',
    'JobPostEval.titleRelavency as titleRelavency',
    'JobPostEval.titleRelavencyReason as titleRelavencyReason',
    'JobPostEval.interestScore as interestScore',
    'JobPostEval.interestScoreReason as interestScoreReason',
    'JobPostEval.skillScore as skillScore',
    'JobPostEval.skillScoreReason as skillScoreReason',
    'JobPostEval.skillScoreBreakdown as skillScoreBreakdownJson',
  ]);

  switch (sort) {
    case 'overall':
      q = q.orderBy(
        sql`"JobPostEval"."skillScore" * "JobPostEval"."interestScore"`,
        ob => ob.desc().nullsLast()
      );
      break;
    case 'interest':
      q = q.orderBy('JobPostEval.interestScore', ob => ob.desc().nullsLast());
      break;
    case 'skill':
      q = q.orderBy('JobPostEval.skillScore', ob => ob.desc().nullsLast());
      break;
  }

  const rows = await q.limit(limit).execute();
  return rows.map(r => {
    const { skillScoreBreakdownJson, skillRequirementsJson, ...rest } = r;
    return {
      ...rest,
      postedAtSource: narrowPostedAtSource(r.postedAtSource),
      skillScoreBreakdown: parseJsonArray<SkillBreakdownEntry>(
        skillScoreBreakdownJson
      ),
      skillRequirements: parseJsonArray<SkillRequirements[number]>(
        skillRequirementsJson
      ),
      overallScore:
        r.skillScore != null && r.interestScore != null
          ? r.skillScore * r.interestScore
          : null,
    };
  });
}

/** The DB stores `postedAtSource` as plain text, but we constrain it to the
 * documented set of values. Unknown / unexpected strings degrade to `null`. */
function narrowPostedAtSource(
  raw: string | null
): JobPostRow['postedAtSource'] {
  if (raw === 'job_post' || raw === 'twbm') return raw;
  return null;
}

function parseJsonArray<T>(json: string | null): T[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : null;
  } catch {
    return null;
  }
}

export async function listSources(): Promise<SourceRow[]> {
  // jobPostCount only counts posts whose JobPostEval.titleRelavency cleared
  // the viewing threshold — i.e. the same set the bar's `inScopeForViewing`
  // gates on. Posts below the threshold won't be viewed/evaluated, so they
  // shouldn't pad the per-source "posts" column either. Implemented as a
  // conditional COUNT over the LEFT JOIN to JobPostEval; uses SUM(CASE…) to
  // avoid the gotcha where COUNT(NULL) returns 0 from a LEFT JOIN — the same
  // expression works on rows whose JobPostEval is missing (titleRelavency
  // IS NULL → falls in the ELSE 0 branch).
  const rows = await db
    .selectFrom('JobSource')
    .leftJoin('JobListSource', 'JobListSource.ofJobSourceId', 'JobSource.id')
    .leftJoin('JobPost', 'JobPost.ofJobListSourceId', 'JobListSource.id')
    .leftJoin('JobPostEval', 'JobPostEval.ofJobPostId', 'JobPost.id')
    .leftJoin('LatestPipelineState as sourceState', join =>
      join
        .onRef('sourceState.ofJobSourceId', '=', 'JobSource.id')
        .on('sourceState.task', '=', 'listing')
    )
    .leftJoin('LatestPipelineState as listState', join =>
      join
        .onRef('listState.ofJobListSourceId', '=', 'JobListSource.id')
        .on('listState.task', '=', 'run-scripts')
    )
    .select(eb => [
      'JobSource.id as sourceId',
      'JobSource.name as sourceName',
      'JobSource.url as sourceUrl',
      'JobSource.isActive as sourceIsActive',
      'sourceState.state as sourceLatestState',
      'JobListSource.id as listId',
      'JobListSource.url as listUrl',
      'JobListSource.isActive as listIsActive',
      'listState.state as listLatestState',
      'JobListSource.locations as listLocations',
      'JobListSource.divisions as listDivisions',
      'JobListSource.parserScript as listParserScript',
      eb.fn
        .sum<number>(
          eb
            .case()
            .when(
              'JobPostEval.titleRelavency',
              '>=',
              PIPELINE_VIEWING_MIN_TITLE_RELEVANCY
            )
            .then(1)
            .else(0)
            .end()
        )
        .as('jobPostCount'),
    ])
    .groupBy(['JobSource.id', 'JobListSource.id'])
    .orderBy(sql`"jobPostCount"`, 'desc')
    .orderBy('JobSource.name', 'asc')
    .orderBy('JobListSource.createdAt', 'asc')
    .execute();

  const sourceRows: SourceRow[] = rows.map(r => {
    const listIsActive = r.listIsActive ?? null;
    const sourceIsActive = r.sourceIsActive ?? 0;
    return {
      rowKey: `${r.sourceId}::${r.listId ?? ''}`,
      kind: 'source',
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      sourceUrl: r.sourceUrl,
      sourceIsActive,
      sourceIsProcessed: isDoneState(r.sourceLatestState) ? 1 : 0,
      listId: r.listId,
      listUrl: r.listUrl,
      listIsActive,
      listIsProcessed:
        r.listId == null ? null : isDoneState(r.listLatestState) ? 1 : 0,
      listLocations: r.listLocations,
      listDivisions: r.listDivisions,
      hasScript: r.listParserScript ? 1 : 0,
      jobPostCount: Number(r.jobPostCount),
      isActive: r.listId ? (listIsActive ?? 0) : sourceIsActive,
    };
  });

  const seedRows = await listPendingSeedRows();
  return [...sourceRows, ...seedRows];
}

/** SourceSeeds whose latest `sourcing` state is anything other than `done` —
 * i.e. they've been approved but haven't yet produced a JobSource (queued,
 * started, failed, user_interrupted, no_source_found, etc.). Rendered as
 * read-only "seed" rows alongside real sources. */
async function listPendingSeedRows(): Promise<SourceRow[]> {
  const rows = await db
    .selectFrom('SourceSeed')
    .innerJoin('LatestPipelineState', join =>
      join
        .onRef('LatestPipelineState.ofSourceSeedId', '=', 'SourceSeed.id')
        .on('LatestPipelineState.task', '=', 'sourcing')
    )
    .select([
      'SourceSeed.id as sourceId',
      'SourceSeed.name as sourceName',
      'SourceSeed.url as sourceUrl',
    ])
    .where('LatestPipelineState.state', '!=', PIPELINE_STATE.DONE)
    .orderBy('SourceSeed.name', 'asc')
    .execute();

  return rows.map(r => ({
    rowKey: `seed::${r.sourceId}`,
    kind: 'seed',
    sourceId: r.sourceId,
    sourceName: r.sourceName,
    sourceUrl: r.sourceUrl,
    sourceIsActive: 0,
    sourceIsProcessed: 0,
    listId: null,
    listUrl: null,
    listIsActive: null,
    listIsProcessed: null,
    listLocations: null,
    listDivisions: null,
    hasScript: 0,
    jobPostCount: 0,
    isActive: null,
  }));
}

function isDoneState(state: string | null | undefined): boolean {
  if (state == null) return false;
  return (
    TERMINAL_SUCCESS_STATES.has(state) || TERMINAL_NO_RESULT_STATES.has(state)
  );
}

export async function toggleSourceActive(row: SourceRow): Promise<void> {
  // Seed rows aren't backed by a JobSource yet — there's nothing to toggle.
  if (row.kind === 'seed') return;
  const next = row.isActive ? Bool.False : Bool.True;
  if (row.listId) {
    await db
      .updateTable('JobListSource')
      .set({ isActive: next })
      .where('id', '=', row.listId)
      .execute();
  } else {
    await db
      .updateTable('JobSource')
      .set({ isActive: next })
      .where('id', '=', row.sourceId)
      .execute();
  }

  bumpLocalRevision();
}

export async function getRecentActivity(limit = 20): Promise<ActivityRow[]> {
  const rows = await db
    .selectFrom('PipelineState')
    .select([
      'task',
      'state',
      'reason',
      'createdAt',
      'ofSourceSeedId',
      'ofJobSourceId',
      'ofJobListSourceId',
      'ofJobPostId',
    ])
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .execute();

  return rows.map(r => ({
    task: r.task,
    state: r.state,
    reason: r.reason,
    createdAt: r.createdAt,
    entity:
      r.ofJobPostId ??
      r.ofJobListSourceId ??
      r.ofJobSourceId ??
      r.ofSourceSeedId ??
      '',
  }));
}
