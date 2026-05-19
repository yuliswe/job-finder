import { sql } from 'kysely';

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
  qualifiedForEvaluate,
  qualifiedForListing,
  qualifiedForRunScripts,
  qualifiedForScripting,
  qualifiedForSourcing,
  qualifiedForViewing,
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
  /** Entities whose latest state is a terminal-success value with a result. */
  done: number;
  /** Entities whose latest state is terminal-completed but produced no result
   * (not_a_job_posting, no_*_found). */
  noResult: number;
  /** Entities whose latest state is a terminal failure (failed, aborted,
   * script_error, etc.). */
  failed: number;
  /** Entities whose latest state is queued — waiting for pickup. */
  queued: number;
  /** Entities whose latest state is started — actively being processed (or
   * left over from a crashed run, which the next pipeline call will retry). */
  started: number;
  /** done + noResult + failed + queued + started. */
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
  /** Effective active flag — JobListSource's when present, else JobSource's. */
  isActive: number;
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
  // For each task X, group LatestPipelineState rows by `state` and count.
  // `total` is every entity that has any history for this task; `done` is the
  // subset whose latest state is a terminal-success value. The base query
  // filters to entities whose owning source tree is still active so toggling
  // a Source/ListSource off shrinks the bar in the TUI to match what the
  // pipeline will actually process.
  return Promise.all(TASK_ORDER.map(stageStats));
}

async function stageStats(task: PipelineTask): Promise<PipelineStageStats> {
  const rows = await stageStatsQuery(task)
    .select([
      'LatestPipelineState.state as state',
      db.fn.countAll<number>().as('n'),
    ])
    .groupBy('LatestPipelineState.state')
    .execute();

  let done = 0;
  let noResult = 0;
  let failed = 0;
  let queued = 0;
  let started = 0;
  for (const r of rows) {
    const n = Number(r.n ?? 0);
    if (r.state == null) continue;
    // user_interrupted is terminal in the data model (won't be auto-re-picked)
    // but the TUI buckets it under `queued` so it shows as pending in the bar
    // rather than a yellow "no-result" — a Ctrl+C is not really an outcome.
    if (r.state === PIPELINE_STATE.USER_INTERRUPTED) queued += n;
    else if (TERMINAL_SUCCESS_STATES.has(r.state)) done += n;
    else if (TERMINAL_NO_RESULT_STATES.has(r.state)) noResult += n;
    else if (r.state === PIPELINE_STATE.QUEUED) queued += n;
    else if (r.state === PIPELINE_STATE.STARTED) started += n;
    else failed += n;
  }

  return {
    task,
    label: task,
    done,
    noResult,
    failed,
    queued,
    started,
    total: done + noResult + failed + queued + started,
  };
}

function stageStatsQuery(task: PipelineTask) {
  // Every bar uses the SAME predicate the pipeline command uses to pick work,
  // wrapped in an EXISTS keyed on the relevant FK. That way bar counts and
  // what the CLI will actually process are guaranteed to agree.
  const q = db
    .selectFrom('LatestPipelineState')
    .where('LatestPipelineState.task', '=', task);

  switch (task) {
    case 'seeding':
    case 'sourcing':
      return q.where(eb =>
        eb.exists(
          eb
            .selectFrom('SourceSeed')
            .select('SourceSeed.id')
            .whereRef(
              'SourceSeed.id',
              '=',
              'LatestPipelineState.ofSourceSeedId'
            )
            .where(qualifiedForSourcing)
        )
      );
    case 'listing':
      return q.where(eb =>
        eb.exists(
          eb
            .selectFrom('JobSource')
            .select('JobSource.id')
            .whereRef('JobSource.id', '=', 'LatestPipelineState.ofJobSourceId')
            .where(qualifiedForListing)
        )
      );
    case 'scripting':
      return q.where(eb =>
        eb.exists(
          eb
            .selectFrom('JobListSource')
            .select('JobListSource.id')
            .whereRef(
              'JobListSource.id',
              '=',
              'LatestPipelineState.ofJobListSourceId'
            )
            .where(qualifiedForScripting)
        )
      );
    case 'run-scripts':
      return q.where(eb =>
        eb.exists(
          eb
            .selectFrom('JobListSource')
            .select('JobListSource.id')
            .whereRef(
              'JobListSource.id',
              '=',
              'LatestPipelineState.ofJobListSourceId'
            )
            .where(qualifiedForRunScripts)
        )
      );
    case 'viewing':
      return q.where(eb =>
        eb.exists(
          eb
            .selectFrom('JobPost')
            .select('JobPost.id')
            .whereRef('JobPost.id', '=', 'LatestPipelineState.ofJobPostId')
            .where(qualifiedForViewing)
        )
      );
    case 'evaluate':
      return q.where(eb =>
        eb.exists(
          eb
            .selectFrom('JobPost')
            .select('JobPost.id')
            .whereRef('JobPost.id', '=', 'LatestPipelineState.ofJobPostId')
            .where(qualifiedForEvaluate)
        )
      );
  }
}

export async function listJobPosts(args: {
  sort: JobPostSortKey;
  limit?: number;
}): Promise<JobPostRow[]> {
  const { sort, limit = 500 } = args;

  let q = db
    .selectFrom('JobPost')
    .leftJoin('JobPostEval', 'JobPostEval.ofJobPostId', 'JobPost.id')
    .where(jobPostInActiveSource)
    .select([
      'JobPost.id as id',
      'JobPost.title as title',
      'JobPost.url as url',
      'JobPost.company as company',
      'JobPost.location as location',
      'JobPost.isRemote as isRemote',
      'JobPost.postedAt as postedAt',
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
  const rows = await db
    .selectFrom('JobSource')
    .leftJoin('JobListSource', 'JobListSource.ofJobSourceId', 'JobSource.id')
    .leftJoin('JobPost', 'JobPost.ofJobListSourceId', 'JobListSource.id')
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
    .select([
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
      db.fn.count<number>('JobPost.id').as('jobPostCount'),
    ])
    .groupBy(['JobSource.id', 'JobListSource.id'])
    .orderBy(sql`"jobPostCount"`, 'desc')
    .orderBy('JobSource.name', 'asc')
    .orderBy('JobListSource.createdAt', 'asc')
    .execute();

  return rows.map(r => {
    const listIsActive = r.listIsActive ?? null;
    const sourceIsActive = r.sourceIsActive ?? 0;
    return {
      rowKey: `${r.sourceId}::${r.listId ?? ''}`,
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
}

function isDoneState(state: string | null | undefined): boolean {
  if (state == null) return false;
  return (
    TERMINAL_SUCCESS_STATES.has(state) || TERMINAL_NO_RESULT_STATES.has(state)
  );
}

export async function toggleSourceActive(row: SourceRow): Promise<void> {
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
