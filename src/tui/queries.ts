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
  /** The `PipelineState.reason` behind a terminal `Failed` / `No result`
   * status (e.g. the LLM error that exhausted research-company's retries),
   * else `null`. Surfaced in the detail panel; the list's status cell is too
   * narrow for it. */
  statusReason: string | null;
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

/** The bucket a stage's latest `PipelineState` falls into. This is the single
 * classifier shared by the pipeline bar (`stageStats`) and the per-row status
 * column (`pendingStageLabel`) so the two can never disagree about what counts
 * as pending versus a terminal outcome — the drift between them is exactly the
 * bug this consolidates away.
 *
 * `null` (no state row yet) is the not-yet-enqueued backlog, treated as
 * `queued`. `user_interrupted` is checked before the no-result set it also
 * belongs to because a Ctrl+C is pending work, not an outcome. Any unrecognized
 * state (including `created`) is treated as `failed`, matching the bar's
 * historical fall-through. */
type StateBucket = 'queued' | 'started' | 'done' | 'noResult' | 'failed';

function classifyPipelineState(state: string | null): StateBucket {
  if (state == null) return 'queued';
  if (state === PIPELINE_STATE.USER_INTERRUPTED) return 'queued';
  if (TERMINAL_SUCCESS_STATES.has(state)) return 'done';
  if (TERMINAL_NO_RESULT_STATES.has(state)) return 'noResult';
  if (state === PIPELINE_STATE.QUEUED) return 'queued';
  if (state === PIPELINE_STATE.STARTED) return 'started';
  return 'failed';
}

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

    switch (classifyPipelineState(b.state)) {
      case 'queued':
        queued += n;
        break;
      case 'started':
        started += n;
        break;
      case 'done':
        done += n;
        break;
      case 'noResult':
        noResult += n;
        break;
      case 'failed':
        failed += n;
        break;
    }
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

/** Label a stage should carry given its latest `PipelineState`, or `null` when
 * the caller should fall back to what the JobPost/JobPostEval result columns
 * imply. Returns null only in the two cases where the result columns are the
 * better source of truth: `null` state (never enqueued — the genuine backlog,
 * where an empty result column really does mean "queued") and terminal-`done`
 * success (where the populated result column implies the next step).
 *
 * Every other state gets an explicit label drawn from the same
 * {@link classifyPipelineState} buckets the pipeline bar uses. Crucially a
 * terminal no-result (`not_a_job_posting`, `no_source_found`, …) now reads as
 * `No result` instead of falling through to the result-column inference, which
 * would mislabel it `Queued` — the row has run and terminated, exactly as the
 * bar's `noResult` bucket records, so the status column must not claim it is
 * still pending. Surfacing queued/started/failed here is also what makes a
 * `jobfinder reset <stage>` — which appends a fresh `queued` row without
 * clearing the prior run's result columns — show up in the status cell
 * immediately. */
function pendingStageLabel(state: string | null): string | null {
  switch (classifyPipelineState(state)) {
    case 'queued':
      // A null state is the not-yet-enqueued backlog: defer to the result
      // columns (an empty one there genuinely means queued). An explicit
      // queued / user_interrupted row is surfaced directly.
      return state == null ? null : 'Queued';
    case 'started':
      return 'Started';
    case 'failed':
      return 'Failed';
    case 'noResult':
      return 'No result';
    case 'done':
      return null;
  }
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
      // Latest pipeline state per source stage, so `computeSourceStatus` can
      // tell a stage that is genuinely pending from one that ran and reached a
      // terminal failed / no-result outcome — the same distinction the
      // pipeline bar draws. Without these it inferred "Queued" from an empty
      // result column alone and mislabeled failed / no-result rows as pending.
      // research-company / identify-job-list-url key off JobSource; the two
      // list stages key off the active JobListSource (`list`). Each is an
      // index-backed O(log N) correlated subquery, matching `latestJobPostState`.
      eb
        .selectFrom('PipelineState')
        .select('PipelineState.state')
        .whereRef('PipelineState.ofJobSourceId', '=', 'JobSource.id')
        .where('PipelineState.task', '=', 'research-company')
        .orderBy('PipelineState.createdAt', 'desc')
        .orderBy('PipelineState.id', 'desc')
        .limit(1)
        .as('researchCompanyState'),
      eb
        .selectFrom('PipelineState')
        .select('PipelineState.state')
        .whereRef('PipelineState.ofJobSourceId', '=', 'JobSource.id')
        .where('PipelineState.task', '=', 'identify-job-list-url')
        .orderBy('PipelineState.createdAt', 'desc')
        .orderBy('PipelineState.id', 'desc')
        .limit(1)
        .as('identifyJobListUrlState'),
      eb
        .selectFrom('PipelineState')
        .select('PipelineState.state')
        .whereRef('PipelineState.ofJobListSourceId', '=', 'list.id')
        .where('PipelineState.task', '=', 'learn-to-use-job-list')
        .orderBy('PipelineState.createdAt', 'desc')
        .orderBy('PipelineState.id', 'desc')
        .limit(1)
        .as('learnToUseJobListState'),
      eb
        .selectFrom('PipelineState')
        .select('PipelineState.state')
        .whereRef('PipelineState.ofJobListSourceId', '=', 'list.id')
        .where('PipelineState.task', '=', 'apply-filters')
        .orderBy('PipelineState.createdAt', 'desc')
        .orderBy('PipelineState.id', 'desc')
        .limit(1)
        .as('applyFiltersState'),
      // The `reason` recorded with each stage's latest state, so the detail
      // panel can explain a `Failed` / `No result` status (e.g. the LLM error
      // that exhausted research-company's retries). Same latest-row ordering as
      // the state subqueries above, so state and reason come from one row.
      eb
        .selectFrom('PipelineState')
        .select('PipelineState.reason')
        .whereRef('PipelineState.ofJobSourceId', '=', 'JobSource.id')
        .where('PipelineState.task', '=', 'research-company')
        .orderBy('PipelineState.createdAt', 'desc')
        .orderBy('PipelineState.id', 'desc')
        .limit(1)
        .as('researchCompanyReason'),
      eb
        .selectFrom('PipelineState')
        .select('PipelineState.reason')
        .whereRef('PipelineState.ofJobSourceId', '=', 'JobSource.id')
        .where('PipelineState.task', '=', 'identify-job-list-url')
        .orderBy('PipelineState.createdAt', 'desc')
        .orderBy('PipelineState.id', 'desc')
        .limit(1)
        .as('identifyJobListUrlReason'),
      eb
        .selectFrom('PipelineState')
        .select('PipelineState.reason')
        .whereRef('PipelineState.ofJobListSourceId', '=', 'list.id')
        .where('PipelineState.task', '=', 'learn-to-use-job-list')
        .orderBy('PipelineState.createdAt', 'desc')
        .orderBy('PipelineState.id', 'desc')
        .limit(1)
        .as('learnToUseJobListReason'),
      eb
        .selectFrom('PipelineState')
        .select('PipelineState.reason')
        .whereRef('PipelineState.ofJobListSourceId', '=', 'list.id')
        .where('PipelineState.task', '=', 'apply-filters')
        .orderBy('PipelineState.createdAt', 'desc')
        .orderBy('PipelineState.id', 'desc')
        .limit(1)
        .as('applyFiltersReason'),
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
      ...computeSourceStatus({
        score,
        sourceIsActive,
        listId: r.listId,
        hasScript,
        jobPostCount,
        abortListingReason: r.abortListingReason,
        researchCompanyState: r.researchCompanyState,
        identifyJobListUrlState: r.identifyJobListUrlState,
        learnToUseJobListState: r.learnToUseJobListState,
        applyFiltersState: r.applyFiltersState,
        researchCompanyReason: r.researchCompanyReason,
        identifyJobListUrlReason: r.identifyJobListUrlReason,
        learnToUseJobListReason: r.learnToUseJobListReason,
        applyFiltersReason: r.applyFiltersReason,
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
 * Walks the source's stages in order and, for each, prefers the stage's latest
 * `PipelineState` (via {@link pendingStageLabel}) over what the result column
 * implies — so a stage that ran and reached a terminal failed / no-result
 * outcome reads as `Failed` / `No result`, matching the pipeline bar's buckets,
 * rather than being mislabeled `Queued` from its still-empty result column.
 * Only when a stage has no active/terminal state (never enqueued, or done) does
 * the empty result column stand in as the "queued" signal. Out-of-scope
 * verdicts still shadow everything downstream of research-company. */
/** The reason recorded with a stage's latest state is only meaningful to
 * surface when that state is a terminal `Failed` / `No result` — those are the
 * outcomes a user needs an explanation for. Returns null for any other label so
 * the detail panel stays quiet on healthy / pending stages. */
function terminalStatusReason(
  label: string | null,
  reason: string | null
): string | null {
  return label === 'Failed' || label === 'No result' ? (reason ?? null) : null;
}

function computeSourceStatus(args: {
  score: number | null;
  sourceIsActive: number;
  listId: string | null;
  hasScript: number;
  jobPostCount: number;
  abortListingReason: string | null;
  researchCompanyState: string | null;
  identifyJobListUrlState: string | null;
  learnToUseJobListState: string | null;
  applyFiltersState: string | null;
  researchCompanyReason: string | null;
  identifyJobListUrlReason: string | null;
  learnToUseJobListReason: string | null;
  applyFiltersReason: string | null;
}): { status: string; statusReason: string | null } {
  const {
    score,
    sourceIsActive,
    listId,
    hasScript,
    jobPostCount,
    abortListingReason,
    researchCompanyState,
    identifyJobListUrlState,
    learnToUseJobListState,
    applyFiltersState,
    researchCompanyReason,
    identifyJobListUrlReason,
    learnToUseJobListReason,
    applyFiltersReason,
  } = args;

  const researchLabel = pendingStageLabel(researchCompanyState);
  if (researchLabel)
    return {
      status: fmtStatus(researchLabel, 'research-company'),
      statusReason: terminalStatusReason(researchLabel, researchCompanyReason),
    };
  if (score == null)
    return {
      status: fmtStatus('Queued', 'research-company'),
      statusReason: null,
    };

  if (sourceIsActive !== 1) {
    return {
      status: fmtStatus('Out-of-scope', 'identify-job-list-url', 'deactivated'),
      statusReason: null,
    };
  }

  if (score < PIPELINE_IDENTIFY_JOB_LIST_URL_MIN_INTEREST_SCORE) {
    return {
      status: fmtStatus(
        'Out-of-scope',
        'identify-job-list-url',
        'low interest'
      ),
      statusReason: null,
    };
  }

  const identifyLabel = pendingStageLabel(identifyJobListUrlState);
  if (identifyLabel) {
    // A terminal identify outcome (`No result` when BFS gave up, or `Failed`)
    // carries the LLM's abort reason when there is one, so the user sees WHY it
    // won't auto-retry — the enrichment the old `Aborted: …` branch provided.
    const inlineReason =
      (identifyLabel === 'No result' || identifyLabel === 'Failed') &&
      abortListingReason
        ? abortListingReason
        : undefined;

    return {
      status: fmtStatus(identifyLabel, 'identify-job-list-url', inlineReason),
      statusReason: terminalStatusReason(
        identifyLabel,
        identifyJobListUrlReason
      ),
    };
  }

  if (listId == null) {
    if (abortListingReason) {
      return {
        status: fmtStatus(
          'Aborted',
          'identify-job-list-url',
          abortListingReason
        ),
        statusReason: abortListingReason,
      };
    }

    return {
      status: fmtStatus('Queued', 'identify-job-list-url'),
      statusReason: null,
    };
  }

  const learnLabel = pendingStageLabel(learnToUseJobListState);
  if (learnLabel)
    return {
      status: fmtStatus(learnLabel, 'learn-to-use-job-list'),
      statusReason: terminalStatusReason(learnLabel, learnToUseJobListReason),
    };
  if (hasScript === 0)
    return {
      status: fmtStatus('Queued', 'learn-to-use-job-list'),
      statusReason: null,
    };

  const applyLabel = pendingStageLabel(applyFiltersState);
  if (applyLabel)
    return {
      status: fmtStatus(applyLabel, 'apply-filters'),
      statusReason: terminalStatusReason(applyLabel, applyFiltersReason),
    };
  // A list with no posts is only "queued" while apply-filters has never run
  // (no state row). Once it has run to `done`, zero posts is a terminal
  // success — the list simply had nothing matching — which the bar counts as
  // done; reporting it as pending is exactly the queued/0-queued mismatch this
  // guards against. Unlike the upstream stages, done-with-empty-result is
  // legitimate here, so this stage alone needs the state check.
  if (applyFiltersState == null && jobPostCount === 0)
    return {
      status: fmtStatus('Queued', 'apply-filters'),
      statusReason: null,
    };
  return { status: fmtStatus('Done', 'apply-filters'), statusReason: null };
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
