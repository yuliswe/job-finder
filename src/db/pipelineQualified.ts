import { sql, type ExpressionBuilder, type SqlBool } from 'kysely';

import type { DB } from '__generated__/db/types.js';
import {
  PIPELINE_IDENTIFY_JOB_LIST_URL_MIN_INTEREST_SCORE,
  PIPELINE_VIEW_JOB_DETAIL_MIN_LOCATION_RELEVANCY,
  PIPELINE_VIEW_JOB_DETAIL_MIN_TITLE_RELEVANCY,
} from 'src/utils/config.js';
import {
  jobListSourceInActiveSource,
  jobPostInActiveSource,
} from 'src/db/activeSource.js';
import { Bool } from 'src/db/customTypes.js';

// Row predicates over each task's parent table, used by every pipeline
// command's picker. Three independent axes:
//
//   qualifiedForX  Row has the upstream-prereq DATA the task reads (e.g.
//                  qualifiedForApplyFilters = parserScript IS NOT NULL).
//                  Trivial when there's no prereq.
//
//   inScopeForX    Should the pipeline ever touch this row at all? Active-
//                  tree membership + design-time skips (e.g. relevancy
//                  threshold). The TUI bar uses this as the denominator.
//
//   neededForX     Is there work left? Defined only when the task's output
//                  is a column on the parent table (research-company → url +
//                  summary + interest*). Null column = work remains.
//                  Tasks whose output is a child-table row don't have
//                  this axis.
//
// Each CLI command AND-combines them with a state filter chosen by mode:
//
//   default          qualified ∩ inScope ∩ needed ∩ state∈{queued,user_interrupted}
//   --include-failed qualified ∩ inScope ∩ needed ∩ state ≠ done
//   --all            qualified ∩ inScope                                    (drops needed and state filter; also pre-runs requeueAllInScope so the bar shows the row set as pending)
//
// `neededForX` only applies when the task defines it; otherwise treat it
// as ALWAYS_TRUE. `--all` is the escape hatch when you genuinely want to
// re-process completed rows (e.g. after a prompt change). Modes nest:
// default ⊆ --include-failed ⊆ --all (assuming nothing was deactivated
// between runs).
//
// Worked example — research-company (the only task with `neededForX`):
//
//   id  url    summary  interest  state    needed?
//   ──  ─────  ───────  ────────  ──────   ───────
//   A   acme   filled   filled    done     no
//   B   beta   filled   filled    queued   no    ← stale queued; needed=false skips it
//   C   NULL   NULL     NULL      queued   yes
//   D   delta  NULL     NULL      failed   yes
//   E   NULL   NULL     NULL      (none)   yes
//
//   default          → {C, E}            (B skipped: !needed; D skipped: state=failed)
//   --include-failed → {C, D, E}         (B still skipped: !needed)
//   --all            → {A, B, C, D, E}   (re-LLMs everyone, overwrites cols)
//
// Rule of thumb: don't put "is this done?" checks into `qualifiedForX` —
// done-ness is the picker's concern (via needed and state), not the
// row-data predicate's.

/** `1` rendered as a SqlBool so the trivial qualifiedForX predicates can be
 * used wherever a boolean expression is expected. */
const ALWAYS_TRUE = sql<SqlBool>`1`;

/** ExploreHiringCompanies has no row-level data prereq — every SourceSeed is qualified. */
export function qualifiedForExploreHiringCompanies(
  _eb: ExpressionBuilder<DB, 'SourceSeed'>
) {
  return ALWAYS_TRUE;
}

/** Every JobSource is qualified for research-company — `name` is NOT NULL by schema,
 * which is the only row-level prereq the task reads. Whether a row still
 * NEEDS research-company (i.e. `url IS NULL`) is enforced directly by the research-company
 * command's picker, not here. */
export function qualifiedForResearchCompany(
  _eb: ExpressionBuilder<DB, 'JobSource'>
) {
  return ALWAYS_TRUE;
}

/** True iff the row's latest research-company state is `'queued'` — used by the
 * research-company picker as an OR-override so anything explicitly enqueued is always
 * processed, even if it falls outside qualified/scope/needed/state filters.
 * (Literal `'queued'` to avoid a cycle with `src/db/pipelineState.ts`; matches
 * `PIPELINE_STATE.QUEUED`.) */
export function previouslyQueuedForResearchCompany(
  eb: ExpressionBuilder<DB, 'JobSource'>
) {
  return eb.exists(
    eb
      .selectFrom('LatestPipelineState')
      .select('LatestPipelineState.id')
      .whereRef('LatestPipelineState.ofJobSourceId', '=', 'JobSource.id')
      .where('LatestPipelineState.task', '=', 'research-company')
      .where('LatestPipelineState.state', 'in', ['queued', 'user_interrupted'])
  );
}

/** Listing needs a URL to crawl — that's its row-level data prereq. JobSources
 * without a URL (e.g. seeded by name only) wait here until the column is
 * filled in. */
export function qualifiedForIdentifyJobListUrl(
  eb: ExpressionBuilder<DB, 'JobSource'>
) {
  return eb('JobSource.url', 'is not', null);
}

/** LearnToUseJobList has no row-level data prereq — every JobListSource is
 * qualified. (Active-tree membership is a scope concern, not qualification.) */
export function qualifiedForLearnToUseJobList(
  _eb: ExpressionBuilder<DB, 'JobListSource'>
) {
  return ALWAYS_TRUE;
}

/** Apply-filters needs a parser script to execute — that's its row-level data
 * prereq, written upstream by learn-to-use-job-list. */
export function qualifiedForApplyFilters(
  eb: ExpressionBuilder<DB, 'JobListSource'>
) {
  return eb('JobListSource.parserScript', 'is not', null);
}

/** View-job-detail has no row-level data prereq — every JobPost can be fetched. The
 * relevancy threshold is a design-time scope decision, not qualification. */
export function qualifiedForViewJobDetail(
  _eb: ExpressionBuilder<DB, 'JobPost'>
) {
  return ALWAYS_TRUE;
}

/** Evaluate needs the post to have been fetched — description and
 * skillRequirements must be populated. */
export function qualifiedForEvaluateSkillMatch(
  eb: ExpressionBuilder<DB, 'JobPost'>
) {
  return eb.and([
    eb('JobPost.description', 'is not', null),
    eb('JobPost.skillRequirements', 'is not', null),
  ]);
}

/** Fill-form has no row-level data prereq — every JobPost has a `url` by
 * schema, which is all the stage reads. It deliberately does NOT require
 * view-job-detail to have run: the form fields come from the live application page,
 * not from the stored `description`. */
export function qualifiedForFillForm(_eb: ExpressionBuilder<DB, 'JobPost'>) {
  return ALWAYS_TRUE;
}

// ─────────────────────────────────────────────────────────────────────────
// `inScopeForX` — pure-scope predicates. See the header comment at the top
// of this file for the qualified-vs-inscope distinction and worked examples.
// ─────────────────────────────────────────────────────────────────────────
//
// Out-of-scope = parent-table rows we deliberately skip: inactive tree,
// design-time filters (e.g. below relevancy threshold). Status conditions
// (no upstream output yet, self not done) do NOT belong here — they're
// orthogonal pipeline-state concerns applied by the CLI mode filter.
//
// ExploreHiringCompanies and research-company have no skip rule (every SourceSeed is in scope), so
// their `inScopeForX` is trivially true.

/** Every SourceSeed is in scope for explore-hiring-companies. */
export function inScopeForExploreHiringCompanies(
  _eb: ExpressionBuilder<DB, 'SourceSeed'>
) {
  return ALWAYS_TRUE;
}

/** A JobSource is in scope for research-company iff it's active. */
export function inScopeForResearchCompany(
  eb: ExpressionBuilder<DB, 'JobSource'>
) {
  return eb('JobSource.isActive', '=', Bool.True);
}

/** A JobSource is in scope for identify-job-list-url iff it's active. */
export function inScopeForIdentifyJobListUrl(
  eb: ExpressionBuilder<DB, 'JobSource'>
) {
  // Active AND research-company's interestScore cleared the threshold. Null
  // interestScore = research-company hasn't completed yet → out of scope until it
  // does. Low-interest companies are deliberately skipped so we don't burn
  // the identify-job-list-url/learn-to-use-job-list/view-job-detail/evaluate-skill-match budget on them.
  return eb.and([
    eb('JobSource.isActive', '=', Bool.True),
    eb(
      'JobSource.interestScore',
      '>=',
      PIPELINE_IDENTIFY_JOB_LIST_URL_MIN_INTEREST_SCORE
    ),
  ]);
}

/** A JobListSource is in scope for learn-to-use-job-list iff it's in an active source
 * tree. The `parserScript` column is THIS task's own work output — its
 * absence is a pipeline-state concern, not a scope concern. */
export function inScopeForLearnToUseJobList(
  eb: ExpressionBuilder<DB, 'JobListSource'>
) {
  return jobListSourceInActiveSource(eb);
}

/** A JobListSource is in scope for apply-filters iff it's in an active source
 * tree AND learn-to-use-job-list has produced a parser script (the upstream
 * prerequisite). */
export function inScopeForApplyFilters(
  eb: ExpressionBuilder<DB, 'JobListSource'>
) {
  return eb.and([
    jobListSourceInActiveSource(eb),
    eb('JobListSource.parserScript', 'is not', null),
  ]);
}

/** True iff the user has NOT manually pushed this post out of scope via
 * `jobfinder job exclude` or the TUI. A manual exclusion is the one stored
 * scope signal a human controls directly; it is AND-combined into
 * `inScopeForViewJobDetail` so it cascades to `inScopeForEvaluateSkillMatch` and every
 * pipeline picker, exactly as a below-threshold relevancy score would. */
export function notManuallyExcluded(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return eb('JobPost.isManuallyExcluded', '=', Bool.False);
}

/** A JobPost is in scope for view-job-detail iff its tree is active, the user has not
 * manually excluded it, AND its title cleared the relevancy threshold
 * (low-relevancy posts are skipped by design). */
export function inScopeForViewJobDetail(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return eb.and([
    jobPostInActiveSource(eb),
    notManuallyExcluded(eb),
    eb.exists(
      eb
        .selectFrom('JobPostEval')
        .select('JobPostEval.id')
        .whereRef('JobPostEval.ofJobPostId', '=', 'JobPost.id')
        .where(
          'JobPostEval.titleRelavency',
          '>=',
          PIPELINE_VIEW_JOB_DETAIL_MIN_TITLE_RELEVANCY
        )
    ),
  ]);
}

/** A JobPost's location cleared the view-job-detail-stage relevancy gate. True when
 * the post has NO known locationRelevancy yet (null = backlog, not yet scored
 * by view-job-detail) OR its score is at/above `PIPELINE_VIEW_JOB_DETAIL_MIN_LOCATION_RELEVANCY`.
 * Only a KNOWN below-threshold score puts a post out of scope — a location the
 * user does not want is tossed out after view-job-detail without ever reaching
 * evaluate. Mirrors the null-as-backlog convention used for titleRelavency. */
export function locationRelevancyInScope(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return eb.not(
    eb.exists(
      eb
        .selectFrom('JobPostEval')
        .select('JobPostEval.id')
        .whereRef('JobPostEval.ofJobPostId', '=', 'JobPost.id')
        .where('JobPostEval.locationRelevancy', 'is not', null)
        .where(
          'JobPostEval.locationRelevancy',
          '<',
          PIPELINE_VIEW_JOB_DETAIL_MIN_LOCATION_RELEVANCY
        )
    )
  );
}

/** A JobPost is in scope for evaluate-skill-match iff it was in scope for view-job-detail, view-job-detail
 * has actually populated description + skillRequirements (the upstream
 * prerequisite), AND its location cleared the relevancy gate. Posts whose
 * details have not been fetched are out-of-scope until view-job-detail fills
 * those columns; location-mismatched posts
 * are dropped here rather than being evaluated and shown to the user. */
export function inScopeForEvaluateSkillMatch(
  eb: ExpressionBuilder<DB, 'JobPost'>
) {
  return eb.and([
    inScopeForViewJobDetail(eb),
    eb('JobPost.description', 'is not', null),
    eb('JobPost.skillRequirements', 'is not', null),
    locationRelevancyInScope(eb),
  ]);
}

/** A JobPost is in scope for fill-form iff its source tree is active. Unlike
 * view-job-detail, fill-form has no title-relevancy gate: it is triggered explicitly
 * per post by a human via `jobfinder fill-form`, so a post the user chose to
 * fill is in scope by virtue of being chosen. */
export function inScopeForFillForm(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return jobPostInActiveSource(eb);
}

// ─────────────────────────────────────────────────────────────────────────
// `neededForX` — defined only where the task's output is a column on the
// parent table (so "has the row been done?" is a pure data check rather
// than a pipeline-state check). See the header comment for the axis.
// ─────────────────────────────────────────────────────────────────────────

/** A JobSource still needs research-company iff ANY of the columns research-company writes
 * is still null — `url`, `summary`, `interestScore`, `interestScoreReason`.
 * A row missing any one of these hasn't been fully processed by the
 * current research-company flow. */
export function neededForResearchCompany(
  eb: ExpressionBuilder<DB, 'JobSource'>
) {
  return eb.or([
    eb('JobSource.url', 'is', null),
    eb('JobSource.summary', 'is', null),
    eb('JobSource.interestScore', 'is', null),
    eb('JobSource.interestScoreReason', 'is', null),
  ]);
}
