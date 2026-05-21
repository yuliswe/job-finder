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
  inScopeForSourcing,
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
  sourceId: string;
  sourceName: string;
  /** `'-'` when the JobSource has no URL yet (approved but not yet sourced). */
  sourceUrl: string;
  sourceIsActive: number;
  listId: string | null;
  listUrl: string | null;
  listIsActive: number | null;
  listLocations: string | null;
  listDivisions: string | null;
  hasScript: number;
  jobPostCount: number;
  /** Mirrors `listIsActive` — strict JobListSource.isActive, `null` when the
   * source has no JobListSource yet. */
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
    case 'sourcing':
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
            .when(inScopeForSourcing(eb))
            .then(1)
            .else(0)
            .end()
            .as('inScope'),
          eb.ref('LatestPipelineState.state').as('state'),
          eb.fn.countAll<number>().as('n'),
        ])
        .groupBy([sql`"inScope"`, 'LatestPipelineState.state'])
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
  // One row per JobSource. approve-seeds promotes SourceSeed names into
  // JobSource rows (url=null until sourcing fills it in), so there's no
  // need to surface unsourced seeds separately anymore.
  //
  // LEFT JOIN picks the most recent JobListSource per source via an inline
  // subquery — most sources have exactly one list, but when there are
  // several we surface only the latest by createdAt. `jobPostCount` is a
  // scalar subquery so it counts every relevant post under the source
  // regardless of which JobListSource it belongs to. Threshold gates posts
  // the same way the viewing bar / SourceJobsScreen do.
  const rows = await db
    .selectFrom('JobSource')
    .leftJoin(
      eb =>
        eb
          .selectFrom('JobListSource')
          .select([
            'JobListSource.id as id',
            'JobListSource.ofJobSourceId as ofJobSourceId',
            'JobListSource.url as url',
            'JobListSource.isActive as isActive',
            'JobListSource.parserScript as parserScript',
            'JobListSource.locations as locations',
            'JobListSource.divisions as divisions',
          ])
          .where(eb2 =>
            eb2(
              'JobListSource.createdAt',
              '=',
              eb2
                .selectFrom('JobListSource as inner')
                .select(eb3 => eb3.fn.max('inner.createdAt').as('m'))
                .whereRef(
                  'inner.ofJobSourceId',
                  '=',
                  'JobListSource.ofJobSourceId'
                )
            )
          )
          .as('list'),
      join => join.onRef('list.ofJobSourceId', '=', 'JobSource.id')
    )
    .select(eb => [
      'JobSource.id as sourceId',
      'JobSource.name as sourceName',
      'JobSource.url as sourceUrl',
      eb.ref('JobSource.isActive').as('sourceIsActive'),
      'list.id as listId',
      'list.url as listUrl',
      'list.isActive as listIsActive',
      'list.locations as listLocations',
      'list.divisions as listDivisions',
      'list.parserScript as listParserScript',
      eb
        .selectFrom('JobPost')
        .innerJoin('JobPostEval', 'JobPostEval.ofJobPostId', 'JobPost.id')
        .whereRef('JobPost.ofJobSourceId', '=', 'JobSource.id')
        .where(
          'JobPostEval.titleRelavency',
          '>=',
          PIPELINE_VIEWING_MIN_TITLE_RELEVANCY
        )
        .select(eb2 => eb2.fn.countAll<number>().as('n'))
        .as('jobPostCount'),
    ])
    .orderBy(sql`"jobPostCount"`, 'desc')
    .orderBy('JobSource.name', 'asc')
    .execute();

  return rows.map(r => ({
    sourceId: r.sourceId,
    sourceName: r.sourceName,
    sourceUrl: r.sourceUrl ?? '-',
    sourceIsActive: r.sourceIsActive ?? 0,
    listId: r.listId,
    listUrl: r.listUrl,
    listIsActive: r.listIsActive ?? null,
    listLocations: r.listLocations,
    listDivisions: r.listDivisions,
    hasScript: r.listParserScript ? 1 : 0,
    jobPostCount: Number(r.jobPostCount ?? 0),
    isActive: r.listIsActive ?? null,
  }));
}

export async function toggleSourceActive(row: SourceRow): Promise<void> {
  // Rows whose listing hasn't produced a JobListSource yet have nothing to
  // toggle — `active` strictly mirrors JobListSource.isActive.
  if (!row.listId) return;
  const next = row.isActive ? Bool.False : Bool.True;

  await db
    .updateTable('JobListSource')
    .set({ isActive: next })
    .where('id', '=', row.listId)
    .execute();
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
