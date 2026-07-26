import { type ExpressionBuilder, sql } from 'kysely';

import type { DB } from '__generated__/db/types.js';
import {
  PIPELINE_IDENTIFY_JOB_LIST_URL_MIN_INTEREST_SCORE,
  PIPELINE_VIEW_JOB_DETAIL_MIN_LOCATION_RELEVANCY,
  PIPELINE_VIEW_JOB_DETAIL_MIN_TITLE_RELEVANCY,
} from 'src/utils/config.js';
import { jobPostInActiveSource } from 'src/db/activeSource.js';
import { Bool } from 'src/db/customTypes.js';
import { db } from 'src/db/index.js';
import { setJobPostPriorityBump } from 'src/db/jobPostPriority.js';
import {
  ELIGIBLE_FOR_PICKUP_STATES,
  FAILED_STATES,
  PIPELINE_STATE,
  type PipelineTask,
  TERMINAL_NO_RESULT_STATES,
  TERMINAL_SUCCESS_STATES,
} from 'src/db/pipelineState.js';
import {
  inScopeForEvaluateSkillMatch,
  inScopeForIdentifyJobListUrl,
  inScopeForApplyFilters,
  inScopeForLearnToUseJobList,
  inScopeForResearchCompany,
  inScopeForViewJobDetail,
  locationRelevancyInScope,
} from 'src/db/pipelineQualified.js';
import type { SkillBreakdownEntry } from 'src/llm/evaluateJobPost.js';
import type { SkillRequirements } from 'src/llm/viewJobDetail.js';
import { bumpLocalRevision } from 'src/tui/useLiveData.js';

export type PipelineStageStats = {
  task:
    | 'explore-hiring-companies'
    | 'research-company'
    | 'identify-job-list-url'
    | 'learn-to-use-job-list'
    | 'apply-filters'
    | 'view-job-detail'
    | 'evaluate-skill-match';
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
  /** view-job-detail-stage score in [0, 1] of how well the posting's location fits the
   * user's stated preferences. null until view-job-detail scores it. Below
   * `PIPELINE_VIEW_JOB_DETAIL_MIN_LOCATION_RELEVANCY` puts the post out of scope for
   * evaluate (see `locationRelevancyInScope`). */
  locationRelevancy: number | null;
  locationRelevancyReason: string | null;
  interestScore: number | null;
  interestScoreReason: string | null;
  skillScore: number | null;
  skillScoreReason: string | null;
  /** Parsed from the JSON-encoded JobPostEval.skillScoreBreakdown column. */
  skillScoreBreakdown: SkillBreakdownEntry[] | null;
  locationScore: number | null;
  locationScoreReason: string | null;
  /** Parsed from JobPost.skillRequirements — posting-derived only (no CV). */
  skillRequirements: SkillRequirements | null;
  overallScore: number | null;
  description: string | null;
  summary: string | null;
  /** True iff the post is out of scope for the view-job-detail/evaluate pipeline —
   * the user manually excluded it, OR its source tree has been deactivated,
   * OR `titleRelavency` came back below `PIPELINE_VIEW_JOB_DETAIL_MIN_TITLE_RELEVANCY`,
   * OR `locationRelevancy` came back below
   * `PIPELINE_VIEW_JOB_DETAIL_MIN_LOCATION_RELEVANCY`. Null relevancy is NOT
   * considered out-of-scope (treated as "not yet evaluated", same as the
   * identify-job-list-url scope rule treats null interestScore on Sources). The TUI uses
   * this to dim out-of-scope rows when they're surfaced via the 'all' or
   * 'out' scope filter. */
  isOutOfScopeForViewJobDetail: boolean;
  /** Human-readable cause when `isOutOfScopeForViewJobDetail` is true (e.g.
   * `'manually excluded'`, `'deactivated'`, `'low title relevancy'`,
   * `'location mismatch'`), else `null`. Surfaced in the detail panel; see
   * `jobPostOutOfScopeReason`. */
  outOfScopeReason: string | null;
  /** True iff the user manually pushed this post out of scope. Drives the
   * `x` toggle's label in the detail screen and shadows every derived
   * out-of-scope reason. */
  isManuallyExcluded: boolean;
  /** The note attached when the post was manually excluded (via
   * `jobfinder job exclude --reason` or the TUI), else `null`. */
  manualExclusionReason: string | null;
  /** Single-line summary of where this post is in the pipeline. Computed
   * from the other fields; see `computeJobPostStatus`. */
  status: string;
  /** User-applied color tags (keys from `TAGS` config), sorted
   * alphabetically. Empty array when the post is untagged. */
  tags: string[];
  /** ISO timestamp of the last manual priority bump, or `null` when the post
   * has never been bumped. A non-null value lifts the post ahead of the
   * backlog in the view-job-detail/evaluate pickers; see `toggleJobPostBump`. */
  priorityBumpedAt: string | null;
};

export type SourceRow = {
  sourceId: string;
  sourceName: string;
  /** `'-'` when the JobSource has no URL yet (approved but not yet sourced). */
  sourceUrl: string;
  sourceInterestScore: number | null;
  sourceSummary: string | null;
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
  /** True iff the source was either deactivated OR research-company scored it below
   * `PIPELINE_IDENTIFY_JOB_LIST_URL_MIN_INTEREST_SCORE`. Null-score rows (research-company hasn't
   * completed yet) are NOT considered out-of-scope — they're surfaced as
   * backlog regardless of the toggle. The TUI uses this to dim out-of-scope
   * rows when they're shown via `includeOutOfScope`. */
  isOutOfScopeForIdentifyJobListUrl: boolean;
  /** Human-readable cause when `isOutOfScopeForIdentifyJobListUrl` is true (e.g.
   * `'deactivated'`, `'low interest'`), else `null`. Surfaced in the detail
   * panel; see `sourceOutOfScopeReason`. */
  outOfScopeReason: string | null;
  /** LLM-generated reason from the identify-job-list-url BFS when it gave up on this
   * source (`abortSearch=true`). Null when the BFS hasn't aborted or hasn't
   * run yet. Surfaced in the status column when present. */
  abortListingReason: string | null;
  /** Single-line summary of where this source is in the pipeline. Computed
   * from the other fields; see `computeSourceStatus`. */
  status: string;
};

export type ActivityRow = {
  task: string;
  state: string;
  reason: string | null;
  createdAt: string;
  entity: string;
};

export type JobPostSortKey =
  /** Skill × interest × location — the full product, default. */
  | 'all'
  | 'interest'
  | 'skill'
  | 'location'
  /** Skill × location, ignore interest. Useful when the interests file
   * isn't matching well but you trust the skill + location signals. */
  | 'excl. interest'
  /** Skill × interest, ignore location. Useful for ranking by fit alone
   * when you're willing to relocate / consider remote regardless. */
  | 'excl. location';
export type SourceSortKey = 'interest' | 'posts' | 'name';

export async function getPipelineStats(): Promise<PipelineStageStats[]> {
  // Each bar's denominator is its parent table's row count (e.g., learn-to-use-job-list →
  // every JobListSource). Parent rows partition into 5 buckets:
  //   outOfScope = fails `inScopeForX` (deliberately skipped — inactive tree,
  //                below relevancy threshold);
  //   done / noResult / failed = in-scope; bucketed by latest pipeline state;
  //   queued = in-scope; latest state is queued/started/user_interrupted, OR
  //            no LatestPipelineState row exists yet (not-yet-enqueued).
  return Promise.all(BAR_TASKS.map(stageStats));
}

/** The stages drawn in the pipeline progress bar. This is the automated
 * top-down pipeline only — `fill-form` is a human-triggered, per-post stage
 * that `start-pipeline` never runs, so it is deliberately excluded from the bar. */
type BarTask = PipelineStageStats['task'];
const BAR_TASKS: readonly BarTask[] = [
  'explore-hiring-companies',
  'research-company',
  'identify-job-list-url',
  'learn-to-use-job-list',
  'apply-filters',
  'view-job-detail',
  'evaluate-skill-match',
];

type RawBucket = { inScope: number; state: string | null; n: number };

async function stageStats(task: BarTask): Promise<PipelineStageStats> {
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

async function stageRawBuckets(task: BarTask): Promise<RawBucket[]> {
  // Each branch starts from the parent table and pulls the latest pipeline
  // state per row via a correlated scalar subquery on `PipelineState` —
  // which lets SQLite use the `PipelineState_task_of*_createdAt_idx` index
  // for an O(log N) lookup per parent row. The earlier implementation
  // LEFT JOINed the `LatestPipelineState` view, which forced SQLite to
  // materialize the whole view (ROW_NUMBER() OVER (...) + TEMP B-TREE sort)
  // on every refresh — ~1.7 s for the research-company stage alone, hence the TUI
  // freeze on every DB write. The rewrite drops total time for all 7 stages
  // from ~2.3 s to ~50 ms.
  //
  // `state` is null when no PipelineState row exists yet — the
  // not-yet-enqueued case. The bucket-aggregator above treats null as
  // pending, same as before.
  switch (task) {
    case 'explore-hiring-companies':
      // Every SourceSeed is in scope — no skip rule.
      return db
        .selectFrom('SourceSeed')
        .select(eb => [
          sql<number>`1`.as('inScope'),
          latestPipelineStateFor(eb, 'SourceSeed.id', 'ofSourceSeedId', task),
          eb.fn.countAll<number>().as('n'),
        ])
        .groupBy([sql`"state"`])
        .execute() as Promise<RawBucket[]>;
    case 'research-company':
      return db
        .selectFrom('JobSource')
        .select(eb => [
          eb
            .case()
            .when(inScopeForResearchCompany(eb))
            .then(1)
            .else(0)
            .end()
            .as('inScope'),
          latestPipelineStateFor(eb, 'JobSource.id', 'ofJobSourceId', task),
          eb.fn.countAll<number>().as('n'),
        ])
        .groupBy([sql`"inScope"`, sql`"state"`])
        .execute() as Promise<RawBucket[]>;
    case 'identify-job-list-url':
      return db
        .selectFrom('JobSource')
        .select(eb => [
          eb
            .case()
            .when(inScopeForIdentifyJobListUrl(eb))
            .then(1)
            .else(0)
            .end()
            .as('inScope'),
          latestPipelineStateFor(eb, 'JobSource.id', 'ofJobSourceId', task),
          eb.fn.countAll<number>().as('n'),
        ])
        .groupBy([sql`"inScope"`, sql`"state"`])
        .execute() as Promise<RawBucket[]>;
    case 'learn-to-use-job-list':
    case 'apply-filters':
      return db
        .selectFrom('JobListSource')
        .select(eb => [
          eb
            .case()
            .when(
              task === 'learn-to-use-job-list'
                ? inScopeForLearnToUseJobList(eb)
                : inScopeForApplyFilters(eb)
            )
            .then(1)
            .else(0)
            .end()
            .as('inScope'),
          latestPipelineStateFor(
            eb,
            'JobListSource.id',
            'ofJobListSourceId',
            task
          ),
          eb.fn.countAll<number>().as('n'),
        ])
        .groupBy([sql`"inScope"`, sql`"state"`])
        .execute() as Promise<RawBucket[]>;
    case 'view-job-detail':
    case 'evaluate-skill-match':
      return db
        .selectFrom('JobPost')
        .select(eb => [
          eb
            .case()
            .when(
              task === 'view-job-detail'
                ? inScopeForViewJobDetail(eb)
                : inScopeForEvaluateSkillMatch(eb)
            )
            .then(1)
            .else(0)
            .end()
            .as('inScope'),
          latestPipelineStateFor(eb, 'JobPost.id', 'ofJobPostId', task),
          eb.fn.countAll<number>().as('n'),
        ])
        .groupBy([sql`"inScope"`, sql`"state"`])
        .execute() as Promise<RawBucket[]>;
  }
}

/** Build a `(SELECT state FROM PipelineState WHERE task=? AND of*Id=parent.id
 * ORDER BY createdAt DESC, id DESC LIMIT 1) AS state` correlated subquery.
 * Aliased as `"state"` so the outer query can group by it. The covering
 * `PipelineState_task_of*_createdAt_idx` index makes the inner scan O(log N)
 * per parent row. `listJobPosts` builds the same shape (aliased per task) via
 * {@link latestJobPostState}. */
function latestPipelineStateFor<
  P extends 'SourceSeed' | 'JobSource' | 'JobListSource' | 'JobPost',
>(
  eb: ExpressionBuilder<DB, P>,
  parentIdRef: `${P}.id`,
  fk: 'ofSourceSeedId' | 'ofJobSourceId' | 'ofJobListSourceId' | 'ofJobPostId',
  task: PipelineTask
) {
  // TS can't narrow the `of*Id` column statically through the runtime `fk`
  // value, so we cast the EB to a single concrete scope; runtime SQL is
  // unaffected. Same escape hatch `eligibleForPipelineTask` uses.
  const ebConcrete = eb as unknown as ExpressionBuilder<DB, 'JobSource'>;
  return ebConcrete
    .selectFrom('PipelineState')
    .select('PipelineState.state')
    .whereRef(
      `PipelineState.${fk}` as 'PipelineState.ofJobSourceId',
      '=',
      parentIdRef as 'JobSource.id'
    )
    .where('PipelineState.task', '=', task)
    .orderBy('PipelineState.createdAt', 'desc')
    .orderBy('PipelineState.id', 'desc')
    .limit(1)
    .as('state');
}

/** The `latestPipelineStateFor` correlated subquery specialized to JobPost and
 * aliased to `alias`, so `listJobPosts` can pull the latest view-job-detail and
 * evaluate states onto one row. Takes the join-scoped expression builder from
 * `listJobPosts` directly — `JobPost.id` is already in that scope, so unlike
 * the generic helper above it needs no cast. Index-backed via
 * `PipelineState_task_ofJobPostId_createdAt_idx`. */
function latestJobPostState<A extends string>(
  eb: ExpressionBuilder<
    DB,
    'JobPost' | 'JobPostEval' | 'JobSource' | 'JobListSource'
  >,
  task: 'view-job-detail' | 'evaluate-skill-match',
  alias: A
) {
  return eb
    .selectFrom('PipelineState')
    .select('PipelineState.state')
    .whereRef('PipelineState.ofJobPostId', '=', 'JobPost.id')
    .where('PipelineState.task', '=', task)
    .orderBy('PipelineState.createdAt', 'desc')
    .orderBy('PipelineState.id', 'desc')
    .limit(1)
    .as(alias);
}

export async function listJobPosts(args: {
  sort: JobPostSortKey;
  limit?: number;
  /** If set, only return JobPosts belonging to this JobSource. Used by the
   * source-jobs screen. */
  ofJobSourceId?: string;
  /** Filter relative to `inScopeForViewJobDetail`. Default `'in'` matches the
   * historical TUI behavior (active tree + cleared title-relevancy
   * threshold). `'all'` drops both filters and the table dims out-of-scope
   * rows. `'out'` returns only out-of-scope rows for auditing. */
  scope?: ScopeFilter;
}): Promise<JobPostRow[]> {
  const { sort, limit = 500, ofJobSourceId, scope = 'in' } = args;

  let base = db
    .selectFrom('JobPost')
    .leftJoin('JobPostEval', 'JobPostEval.ofJobPostId', 'JobPost.id');

  if (ofJobSourceId) {
    base = base.where('JobPost.ofJobSourceId', '=', ofJobSourceId);
  }

  if (scope === 'in') {
    base = base
      .where(jobPostInActiveSource)
      .where(inScopeForViewJobDetail)
      .where(locationRelevancyInScope);
  } else if (scope === 'out') {
    // Out-of-scope = manually excluded, OR NOT in active source tree, OR title
    // relevancy is known AND below threshold, OR location relevancy is known
    // AND below threshold. Null relevancy stays in 'in' as backlog (matches the
    // Sources-scope treatment of null interestScore).
    base = base.where(eb =>
      eb.or([
        eb('JobPost.isManuallyExcluded', '=', Bool.True),
        eb.not(jobPostInActiveSource(eb)),
        eb.and([
          eb('JobPostEval.titleRelavency', 'is not', null),
          eb(
            'JobPostEval.titleRelavency',
            '<',
            PIPELINE_VIEW_JOB_DETAIL_MIN_TITLE_RELEVANCY
          ),
        ]),
        eb.and([
          eb('JobPostEval.locationRelevancy', 'is not', null),
          eb(
            'JobPostEval.locationRelevancy',
            '<',
            PIPELINE_VIEW_JOB_DETAIL_MIN_LOCATION_RELEVANCY
          ),
        ]),
      ])
    );
  }
  // 'all': no scope filter — return every JobPost regardless.

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
    'JobPost.tags as tagsJson',
    'JobPost.isManuallyExcluded as isManuallyExcluded',
    'JobPost.manualExclusionReason as manualExclusionReason',
    'JobPost.priorityBumpedAt as priorityBumpedAt',
    'JobPostEval.titleRelavency as titleRelavency',
    'JobPostEval.titleRelavencyReason as titleRelavencyReason',
    'JobPostEval.locationRelevancy as locationRelevancy',
    'JobPostEval.locationRelevancyReason as locationRelevancyReason',
    'JobPostEval.interestScore as interestScore',
    'JobPostEval.interestScoreReason as interestScoreReason',
    'JobPostEval.skillScore as skillScore',
    'JobPostEval.skillScoreReason as skillScoreReason',
    'JobPostEval.skillScoreBreakdown as skillScoreBreakdownJson',
    'JobPostEval.locationScore as locationScore',
    'JobPostEval.locationScoreReason as locationScoreReason',
  ]);

  switch (sort) {
    case 'all':
      // Match the in-JS `overallScore` formula: missing locationScore is
      // treated as 1 (neutral) so rows not yet re-evaluated don't sink.
      q = q.orderBy(
        sql`"JobPostEval"."skillScore" * "JobPostEval"."interestScore" * COALESCE("JobPostEval"."locationScore", 1)`,
        ob => ob.desc().nullsLast()
      );
      break;
    case 'interest':
      q = q.orderBy('JobPostEval.interestScore', ob => ob.desc().nullsLast());
      break;
    case 'skill':
      q = q.orderBy('JobPostEval.skillScore', ob => ob.desc().nullsLast());
      break;
    case 'location':
      q = q.orderBy('JobPostEval.locationScore', ob => ob.desc().nullsLast());
      break;
    case 'excl. interest':
      // skill × location, treating missing locationScore as 1 (neutral) so
      // rows not yet re-evaluated don't sink — same convention as 'all'.
      q = q.orderBy(
        sql`"JobPostEval"."skillScore" * COALESCE("JobPostEval"."locationScore", 1)`,
        ob => ob.desc().nullsLast()
      );
      break;
    case 'excl. location':
      // skill × interest. No COALESCE: both scores fill in the same
      // evaluate run, so if one is null the other is too.
      q = q.orderBy(
        sql`"JobPostEval"."skillScore" * "JobPostEval"."interestScore"`,
        ob => ob.desc().nullsLast()
      );
      break;
  }

  // `isOutOfScopeForViewJobDetail` needs the active-tree check, which we don't
  // have on the row directly. Re-evaluate cheaply per row by joining the
  // source's active state into the select.
  const qWithScope = q
    .leftJoin('JobSource', 'JobSource.id', 'JobPost.ofJobSourceId')
    .leftJoin('JobListSource', 'JobListSource.id', 'JobPost.ofJobListSourceId')
    .select([
      'JobSource.isActive as sourceIsActive',
      'JobListSource.isActive as listSourceIsActive',
    ])
    // Latest view-job-detail/evaluate pipeline state per post, so the status column
    // reflects a `jobfinder reset <stage>` (which appends a fresh `queued`
    // PipelineState row without clearing the prior run's description /
    // interestScore). Each is an index-backed O(log N) correlated subquery on
    // `PipelineState_task_ofJobPostId_createdAt_idx` — the same performant
    // pattern `stageRawBuckets` uses — rather than a join on the
    // `LatestPipelineState` view, which would materialize the whole view
    // (ROW_NUMBER + TEMP B-TREE) on every 1s TUI refresh.
    .select(eb => [
      latestJobPostState(eb, 'view-job-detail', 'viewJobDetailState'),
      latestJobPostState(eb, 'evaluate-skill-match', 'evaluateSkillMatchState'),
    ]);

  const rows = await qWithScope.limit(limit).execute();
  return rows.map(r => {
    const {
      skillScoreBreakdownJson,
      skillRequirementsJson,
      tagsJson,
      sourceIsActive,
      listSourceIsActive,
      viewJobDetailState,
      evaluateSkillMatchState,
      isManuallyExcluded: isManuallyExcludedRaw,
      ...rest
    } = r;

    // Mirror `jobPostInActiveSource` in JS: source must be active, and the
    // list source (if any) must also be active. Null listSourceIsActive
    // means no JobListSource, which the SQL helper treats as active.
    const inActiveTree =
      sourceIsActive === 1 &&
      (listSourceIsActive == null || listSourceIsActive === 1);

    const manuallyExcluded = isManuallyExcludedRaw === Bool.True;

    const outOfScopeReason = jobPostOutOfScopeReason({
      manuallyExcluded,
      inActiveTree,
      titleRelavency: r.titleRelavency,
      locationRelevancy: r.locationRelevancy,
    });

    const isOutOfScopeForViewJobDetail = outOfScopeReason != null;

    return {
      ...rest,
      isManuallyExcluded: manuallyExcluded,
      postedAtSource: narrowPostedAtSource(r.postedAtSource),
      skillScoreBreakdown: parseJsonArray<SkillBreakdownEntry>(
        skillScoreBreakdownJson
      ),
      skillRequirements: parseJsonArray<SkillRequirements[number]>(
        skillRequirementsJson
      ),
      overallScore:
        r.skillScore != null && r.interestScore != null
          ? r.skillScore * r.interestScore * (r.locationScore ?? 1)
          : null,
      isOutOfScopeForViewJobDetail,
      outOfScopeReason,
      status: computeJobPostStatus({
        manuallyExcluded,
        inActiveTree,
        titleRelavency: r.titleRelavency,
        locationRelevancy: r.locationRelevancy,
        description: r.description,
        interestScore: r.interestScore,
        viewJobDetailState,
        evaluateSkillMatchState,
      }),
      tags: parseJsonArray<string>(tagsJson) ?? [],
    };
  });
}

/** Toggle a single color tag on a JobPost. Persisted as a sorted JSON
 * array — sorting on every write keeps the column render deterministic and
 * sidesteps any caller having to remember the invariant. Bumps the local
 * revision so the TUI refetches without waiting for the next 1s poll. */
export async function toggleJobPostTag(
  jobPostId: string,
  tagKey: string
): Promise<void> {
  const existing = await db
    .selectFrom('JobPost')
    .select('tags')
    .where('id', '=', jobPostId)
    .executeTakeFirst();

  const current = parseJsonArray<string>(existing?.tags ?? null) ?? [];
  const set = new Set(current);
  if (set.has(tagKey)) set.delete(tagKey);
  else set.add(tagKey);
  const next = [...set].sort();

  await db
    .updateTable('JobPost')
    .set({ tags: next.length === 0 ? null : JSON.stringify(next) })
    .where('id', '=', jobPostId)
    .execute();

  bumpLocalRevision();
}

/** Flip a JobPost's manual out-of-scope override and return the new state so
 * the caller can reflect it immediately. Excluding stamps a default reason
 * (the CLI's `--reason` is where a specific note goes); including clears it.
 * Bumps the local revision so the row re-renders — dimmed, or dropping out of
 * the `in` filter — without waiting for the next 1s poll. */
export async function toggleJobPostExcluded(
  jobPostId: string
): Promise<{ isManuallyExcluded: boolean }> {
  const existing = await db
    .selectFrom('JobPost')
    .select('isManuallyExcluded')
    .where('id', '=', jobPostId)
    .executeTakeFirst();

  const next = existing?.isManuallyExcluded !== Bool.True;

  await db
    .updateTable('JobPost')
    .set({
      isManuallyExcluded: next ? Bool.True : Bool.False,
      manualExclusionReason: next ? 'excluded from TUI' : null,
      updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    })
    .where('id', '=', jobPostId)
    .execute();

  bumpLocalRevision();
  return { isManuallyExcluded: next };
}

/** Toggle the manual priority bump on a JobPost: stamp `priorityBumpedAt` with
 * the current time when it is unset, or clear it when already bumped. A bumped
 * post is picked ahead of the backlog in the view-job-detail/evaluate stages, and
 * re-stamping a second post lifts it above the first ("stackable by
 * recency"). Bumps the local revision so the TUI refetches immediately. */
export async function toggleJobPostBump(jobPostId: string): Promise<void> {
  const existing = await db
    .selectFrom('JobPost')
    .select('priorityBumpedAt')
    .where('id', '=', jobPostId)
    .executeTakeFirst();

  const next = existing?.priorityBumpedAt ? null : new Date().toISOString();
  await setJobPostPriorityBump(jobPostId, next);

  bumpLocalRevision();
}

/** Formats a status cell as `<state>: <stage>`, with an optional trailing
 * `(reason)` when the state needs qualifying (out-of-scope cause, abort
 * message). Both the JobPost and Source status columns render through this
 * so the two tabs read the same way. */
function fmtStatus(
  state: string,
  stage: PipelineTask,
  reason?: string
): string {
  return reason ? `${state}: ${stage} (${reason})` : `${state}: ${stage}`;
}

/** Why a JobPost fails `inScopeForViewJobDetail`, or `null` when it is in scope.
 * Drives both the `isOutOfScopeForViewJobDetail` flag and the `outOfScopeReason`
 * the detail panel surfaces, so the two can never disagree. The reasons are
 * checked in priority order so that a manual exclusion shadows a deactivated
 * source tree, which in turn shadows the relevancy checks.
 * `computeJobPostStatus` mirrors the same conditions for the list's status
 * cell, where it additionally names the pipeline stage each verdict blocks. */
function jobPostOutOfScopeReason(args: {
  manuallyExcluded: boolean;
  inActiveTree: boolean;
  titleRelavency: number | null;
  locationRelevancy: number | null;
}): string | null {
  const { manuallyExcluded, inActiveTree, titleRelavency, locationRelevancy } =
    args;

  if (manuallyExcluded) return 'manually excluded';
  if (!inActiveTree) return 'deactivated';
  if (
    titleRelavency != null &&
    titleRelavency < PIPELINE_VIEW_JOB_DETAIL_MIN_TITLE_RELEVANCY
  ) {
    return 'low title relevancy';
  }

  // Location is scored at view-job-detail time, so this only fires once the post has
  // been fetched. A below-threshold score keeps it out of `evaluate`.
  if (
    locationRelevancy != null &&
    locationRelevancy < PIPELINE_VIEW_JOB_DETAIL_MIN_LOCATION_RELEVANCY
  ) {
    return 'location mismatch';
  }

  return null;
}

/** Label a stage should carry when the given value is its latest
 * `PipelineState`, or `null` when the state is terminal-done (success or a
 * no-result outcome) so the caller falls back to what the JobPost/JobPostEval
 * result columns imply. Surfacing queued/started/failed here is what makes a
 * `jobfinder reset <stage>` — which appends a fresh `queued` row without
 * clearing the prior run's result columns — show up in the status cell
 * immediately. `user_interrupted` reads as `Queued`, matching the pipeline
 * bar's convention (`stageStats`) that a Ctrl+C is pending work, not an
 * outcome. */
function pendingStageLabel(state: string | null): string | null {
  if (state == null) return null;
  if (ELIGIBLE_FOR_PICKUP_STATES.has(state)) return 'Queued';
  if (state === PIPELINE_STATE.STARTED) return 'Started';
  if (FAILED_STATES.has(state)) return 'Failed';
  return null;
}

/** Single-line pipeline status for a JobPost, rendered as `<state>: <stage>`.
 * Out-of-scope verdicts (checked first) shadow everything. Otherwise the
 * status prefers an active pipeline state for the earliest not-yet-done stage
 * over what the result columns imply, so a `reset` that requeues a row is
 * reflected even though the prior run's description / interestScore are still
 * populated. View-job-detail is checked before evaluate because a row requeued for
 * view-job-detail will be re-fetched before it is re-evaluated. */
function computeJobPostStatus(args: {
  manuallyExcluded: boolean;
  inActiveTree: boolean;
  titleRelavency: number | null;
  locationRelevancy: number | null;
  description: string | null;
  interestScore: number | null;
  viewJobDetailState: string | null;
  evaluateSkillMatchState: string | null;
}): string {
  const {
    manuallyExcluded,
    inActiveTree,
    titleRelavency,
    locationRelevancy,
    description,
    interestScore,
    viewJobDetailState,
    evaluateSkillMatchState,
  } = args;

  if (manuallyExcluded)
    return fmtStatus('Out-of-scope', 'view-job-detail', 'manually excluded');
  if (!inActiveTree)
    return fmtStatus('Out-of-scope', 'view-job-detail', 'deactivated');
  if (
    titleRelavency != null &&
    titleRelavency < PIPELINE_VIEW_JOB_DETAIL_MIN_TITLE_RELEVANCY
  ) {
    return fmtStatus('Out-of-scope', 'view-job-detail', 'low title relevancy');
  }

  // Location is scored at view-job-detail time, so this only fires once the post has
  // been fetched. A below-threshold score keeps it out of `evaluate`.
  if (
    locationRelevancy != null &&
    locationRelevancy < PIPELINE_VIEW_JOB_DETAIL_MIN_LOCATION_RELEVANCY
  ) {
    return fmtStatus(
      'Out-of-scope',
      'evaluate-skill-match',
      'location mismatch'
    );
  }

  const viewJobDetailLabel = pendingStageLabel(viewJobDetailState);
  if (viewJobDetailLabel)
    return fmtStatus(viewJobDetailLabel, 'view-job-detail');
  if (!description) return fmtStatus('Queued', 'view-job-detail');

  const evaluateSkillMatchLabel = pendingStageLabel(evaluateSkillMatchState);
  if (evaluateSkillMatchLabel)
    return fmtStatus(evaluateSkillMatchLabel, 'evaluate-skill-match');
  if (interestScore == null) return fmtStatus('Queued', 'evaluate-skill-match');
  return fmtStatus('Done', 'evaluate-skill-match');
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

/** Shared 3-state scope filter, used by both the Sources tab and the Jobs
 * tab. The exact meaning of in/out depends on the tab — Sources keys off
 * `inScopeForIdentifyJobListUrl` (active + interestScore >= threshold), Jobs keys off
 * `inScopeForViewJobDetail` (in active source tree + titleRelavency >= threshold).
 *
 *   - `'in'`  → only in-scope rows (matches the original TUI behavior).
 *   - `'all'` → in-scope PLUS out-of-scope, with the latter rendered dim.
 *   - `'out'` → only out-of-scope rows. Useful for auditing what the
 *               pipeline is skipping. */
export type ScopeFilter = 'in' | 'all' | 'out';

/** @deprecated alias — use {@link ScopeFilter}. Kept so older code that
 * imports the Sources-specific name keeps working. */
export type SourcesScopeFilter = ScopeFilter;

export async function listSources(args: {
  sort: SourceSortKey;
  scope?: ScopeFilter;
}): Promise<SourceRow[]> {
  // One row per JobSource. approve-seeds promotes SourceSeed names into
  // JobSource rows (url=null until research-company fills it in), so there's no
  // need to surface unsourced seeds separately anymore.
  //
  // LEFT JOIN picks the most recent JobListSource per source via an inline
  // subquery — most sources have exactly one list, but when there are
  // several we surface only the latest by createdAt. `jobPostCount` is a
  // scalar subquery so it counts every relevant post under the source
  // regardless of which JobListSource it belongs to. Threshold gates posts
  // the same way the view-job-detail bar / SourceJobsScreen do.
  const { sort, scope = 'in' } = args;
  let query = db.selectFrom('JobSource').leftJoin(
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
  );

  // Default ('in'): hide low-interest. Null score = not yet sourced — still
  // surface those so the user can see backlog progress. 'all' drops the
  // low-interest filter. 'out' inverts: only rows that are out-of-scope
  // for identify-job-list-url — low-interest OR deactivated.
  if (scope === 'in') {
    query = query.where(eb =>
      eb.or([
        eb('JobSource.interestScore', 'is', null),
        eb(
          'JobSource.interestScore',
          '>=',
          PIPELINE_IDENTIFY_JOB_LIST_URL_MIN_INTEREST_SCORE
        ),
      ])
    );
  } else if (scope === 'out') {
    query = query.where(eb =>
      eb.or([
        eb('JobSource.isActive', '!=', Bool.True),
        eb.and([
          eb('JobSource.interestScore', 'is not', null),
          eb(
            'JobSource.interestScore',
            '<',
            PIPELINE_IDENTIFY_JOB_LIST_URL_MIN_INTEREST_SCORE
          ),
        ]),
      ])
    );
  }

  const rows = await query
    .select(eb => [
      'JobSource.id as sourceId',
      'JobSource.name as sourceName',
      'JobSource.url as sourceUrl',
      'JobSource.interestScore as sourceInterestScore',
      'JobSource.summary as sourceSummary',
      'JobSource.abortListingReason as abortListingReason',
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
          PIPELINE_VIEW_JOB_DETAIL_MIN_TITLE_RELEVANCY
        )
        // Exclude posts view-job-detail has scored as a location mismatch, matching the
        // Jobs 'in' scope. Null (not yet fetched) still counts as backlog.
        .where(eb2 =>
          eb2.or([
            eb2('JobPostEval.locationRelevancy', 'is', null),
            eb2(
              'JobPostEval.locationRelevancy',
              '>=',
              PIPELINE_VIEW_JOB_DETAIL_MIN_LOCATION_RELEVANCY
            ),
          ])
        )
        .select(eb2 => eb2.fn.countAll<number>().as('n'))
        .as('jobPostCount'),
    ])
    .$call(q => {
      switch (sort) {
        case 'interest':
          return q
            .orderBy('JobSource.interestScore', ob => ob.desc().nullsLast())
            .orderBy(sql`"jobPostCount"`, 'desc')
            .orderBy('JobSource.name', 'asc');
        case 'posts':
          return q
            .orderBy(sql`"jobPostCount"`, 'desc')
            .orderBy('JobSource.name', 'asc');
        case 'name':
          return q.orderBy('JobSource.name', 'asc');
      }
    })
    .execute();

  return rows.map(r => {
    const sourceIsActive = r.sourceIsActive ?? 0;
    const score = r.sourceInterestScore;
    const outOfScopeReason = sourceOutOfScopeReason({ score, sourceIsActive });
    const isOutOfScopeForIdentifyJobListUrl = outOfScopeReason != null;

    const hasScript = r.listParserScript ? 1 : 0;
    const jobPostCount = Number(r.jobPostCount ?? 0);

    return {
      sourceId: r.sourceId,
      sourceName: r.sourceName,
      sourceUrl: r.sourceUrl ?? '-',
      sourceInterestScore: score,
      sourceSummary: r.sourceSummary,
      sourceIsActive,
      listId: r.listId,
      listUrl: r.listUrl,
      listIsActive: r.listIsActive ?? null,
      listLocations: r.listLocations,
      listDivisions: r.listDivisions,
      hasScript,
      jobPostCount,
      isActive: r.listIsActive ?? null,
      isOutOfScopeForIdentifyJobListUrl,
      outOfScopeReason,
      abortListingReason: r.abortListingReason,
      status: computeSourceStatus({
        score,
        sourceIsActive,
        listId: r.listId,
        hasScript,
        jobPostCount,
        abortListingReason: r.abortListingReason,
      }),
    };
  });
}

/** Why a source fails `inScopeForIdentifyJobListUrl`, or `null` when it is in scope.
 * Mirrors the `isOutOfScopeForIdentifyJobListUrl` predicate: a deactivated source is
 * out-of-scope regardless of score, and a scored source drops out when its
 * interest falls below the threshold. A source that hasn't been scored yet
 * (`score == null`) is not out-of-scope unless it is also deactivated. Drives
 * both the flag and the `outOfScopeReason` the detail panel surfaces;
 * `computeSourceStatus` mirrors the same conditions for the list's status
 * cell. */
function sourceOutOfScopeReason(args: {
  score: number | null;
  sourceIsActive: number;
}): string | null {
  const { score, sourceIsActive } = args;
  if (sourceIsActive !== 1) return 'deactivated';
  if (
    score != null &&
    score < PIPELINE_IDENTIFY_JOB_LIST_URL_MIN_INTEREST_SCORE
  ) {
    return 'low interest';
  }

  return null;
}

/** Single-line pipeline status for a source, rendered as `<state>: <stage>`.
 * Derived from the same fields the rest of SourceRow exposes and checked in
 * priority order — earlier states (still pre-research-company) shadow later ones, and
 * out-of-scope verdicts shadow any queued interpretation. */
function computeSourceStatus(args: {
  score: number | null;
  sourceIsActive: number;
  listId: string | null;
  hasScript: number;
  jobPostCount: number;
  abortListingReason: string | null;
}): string {
  const {
    score,
    sourceIsActive,
    listId,
    hasScript,
    jobPostCount,
    abortListingReason,
  } = args;

  if (score == null) return fmtStatus('Queued', 'research-company');
  if (sourceIsActive !== 1) {
    return fmtStatus('Out-of-scope', 'identify-job-list-url', 'deactivated');
  }

  if (score < PIPELINE_IDENTIFY_JOB_LIST_URL_MIN_INTEREST_SCORE) {
    return fmtStatus('Out-of-scope', 'identify-job-list-url', 'low interest');
  }

  if (listId == null) {
    // BFS already gave up — surface the LLM's reason instead of the bland
    // "Queued: identify-job-list-url" so the user knows it won't auto-retry.
    if (abortListingReason) {
      return fmtStatus('Aborted', 'identify-job-list-url', abortListingReason);
    }

    return fmtStatus('Queued', 'identify-job-list-url');
  }

  if (hasScript === 0) return fmtStatus('Queued', 'learn-to-use-job-list');
  if (jobPostCount === 0) return fmtStatus('Queued', 'apply-filters');
  return fmtStatus('Done', 'apply-filters');
}

export async function toggleSourceActive(row: SourceRow): Promise<void> {
  // Rows whose identify-job-list-url has not produced a JobListSource yet have nothing to
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
