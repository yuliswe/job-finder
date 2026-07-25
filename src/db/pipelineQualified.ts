import { sql, type ExpressionBuilder, type SqlBool } from 'kysely';

import type { DB } from '__generated__/db/types.js';
import {
  PIPELINE_LISTING_MIN_INTEREST_SCORE,
  PIPELINE_VIEWING_MIN_LOCATION_RELEVANCY,
  PIPELINE_VIEWING_MIN_TITLE_RELEVANCY,
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
//                  qualifiedForRunScripts = parserScript IS NOT NULL).
//                  Trivial when there's no prereq.
//
//   inScopeForX    Should the pipeline ever touch this row at all? Active-
//                  tree membership + design-time skips (e.g. relevancy
//                  threshold). The TUI bar uses this as the denominator.
//
//   neededForX     Is there work left? Defined only when the task's output
//                  is a column on the parent table (sourcing → url +
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
// Worked example — sourcing (the only task with `neededForX`):
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

/** Seeding has no row-level data prereq — every SourceSeed is qualified. */
export function qualifiedForSeeding(_eb: ExpressionBuilder<DB, 'SourceSeed'>) {
  return ALWAYS_TRUE;
}

/** Every JobSource is qualified for sourcing — `name` is NOT NULL by schema,
 * which is the only row-level prereq the task reads. Whether a row still
 * NEEDS sourcing (i.e. `url IS NULL`) is enforced directly by the sourcing
 * command's picker, not here. */
export function qualifiedForSourcing(_eb: ExpressionBuilder<DB, 'JobSource'>) {
  return ALWAYS_TRUE;
}

/** True iff the row's latest sourcing state is `'queued'` — used by the
 * sourcing picker as an OR-override so anything explicitly enqueued is always
 * processed, even if it falls outside qualified/scope/needed/state filters.
 * (Literal `'queued'` to avoid a cycle with `src/db/pipelineState.ts`; matches
 * `PIPELINE_STATE.QUEUED`.) */
export function previouslyQueuedForSourcing(
  eb: ExpressionBuilder<DB, 'JobSource'>
) {
  return eb.exists(
    eb
      .selectFrom('LatestPipelineState')
      .select('LatestPipelineState.id')
      .whereRef('LatestPipelineState.ofJobSourceId', '=', 'JobSource.id')
      .where('LatestPipelineState.task', '=', 'sourcing')
      .where('LatestPipelineState.state', 'in', ['queued', 'user_interrupted'])
  );
}

/** Listing needs a URL to crawl — that's its row-level data prereq. JobSources
 * without a URL (e.g. seeded by name only) wait here until the column is
 * filled in. */
export function qualifiedForListing(eb: ExpressionBuilder<DB, 'JobSource'>) {
  return eb('JobSource.url', 'is not', null);
}

/** Scripting has no row-level data prereq — every JobListSource is
 * qualified. (Active-tree membership is a scope concern, not qualification.) */
export function qualifiedForScripting(
  _eb: ExpressionBuilder<DB, 'JobListSource'>
) {
  return ALWAYS_TRUE;
}

/** Run-scripts needs a parser script to execute — that's its row-level data
 * prereq, written upstream by scripting. */
export function qualifiedForRunScripts(
  eb: ExpressionBuilder<DB, 'JobListSource'>
) {
  return eb('JobListSource.parserScript', 'is not', null);
}

/** Viewing has no row-level data prereq — every JobPost can be fetched. The
 * relevancy threshold is a design-time scope decision, not qualification. */
export function qualifiedForViewing(_eb: ExpressionBuilder<DB, 'JobPost'>) {
  return ALWAYS_TRUE;
}

/** Evaluate needs the post to have been viewed — description and
 * skillRequirements must be populated. */
export function qualifiedForEvaluate(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return eb.and([
    eb('JobPost.description', 'is not', null),
    eb('JobPost.skillRequirements', 'is not', null),
  ]);
}

/** Fill-form has no row-level data prereq — every JobPost has a `url` by
 * schema, which is all the stage reads. It deliberately does NOT require
 * viewing to have run: the form fields come from the live application page,
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
// Seeding and sourcing have no skip rule (every SourceSeed is in scope), so
// their `inScopeForX` is trivially true.

/** Every SourceSeed is in scope for seeding. */
export function inScopeForSeeding(_eb: ExpressionBuilder<DB, 'SourceSeed'>) {
  return ALWAYS_TRUE;
}

/** A JobSource is in scope for sourcing iff it's active. */
export function inScopeForSourcing(eb: ExpressionBuilder<DB, 'JobSource'>) {
  return eb('JobSource.isActive', '=', Bool.True);
}

/** A JobSource is in scope for listing iff it's active. */
export function inScopeForListing(eb: ExpressionBuilder<DB, 'JobSource'>) {
  // Active AND sourcing's interestScore cleared the threshold. Null
  // interestScore = sourcing hasn't completed yet → out of scope until it
  // does. Low-interest companies are deliberately skipped so we don't burn
  // the listing/scripting/viewing/evaluate budget on them.
  return eb.and([
    eb('JobSource.isActive', '=', Bool.True),
    eb('JobSource.interestScore', '>=', PIPELINE_LISTING_MIN_INTEREST_SCORE),
  ]);
}

/** A JobListSource is in scope for scripting iff it's in an active source
 * tree. The `parserScript` column is THIS task's own work output — its
 * absence is a pipeline-state concern, not a scope concern. */
export function inScopeForScripting(
  eb: ExpressionBuilder<DB, 'JobListSource'>
) {
  return jobListSourceInActiveSource(eb);
}

/** A JobListSource is in scope for run-scripts iff it's in an active source
 * tree AND scripting has produced a parser script (the upstream
 * prerequisite). */
export function inScopeForRunScripts(
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
 * `inScopeForViewing` so it cascades to `inScopeForEvaluate` and every
 * pipeline picker, exactly as a below-threshold relevancy score would. */
export function notManuallyExcluded(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return eb('JobPost.isManuallyExcluded', '=', Bool.False);
}

/** A JobPost is in scope for viewing iff its tree is active, the user has not
 * manually excluded it, AND its title cleared the relevancy threshold
 * (low-relevancy posts are skipped by design). */
export function inScopeForViewing(eb: ExpressionBuilder<DB, 'JobPost'>) {
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
          PIPELINE_VIEWING_MIN_TITLE_RELEVANCY
        )
    ),
  ]);
}

/** A JobPost's location cleared the viewing-stage relevancy gate. True when
 * the post has NO known locationRelevancy yet (null = backlog, not yet scored
 * by viewing) OR its score is at/above `PIPELINE_VIEWING_MIN_LOCATION_RELEVANCY`.
 * Only a KNOWN below-threshold score puts a post out of scope — a location the
 * user does not want is tossed out after viewing without ever reaching
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
          PIPELINE_VIEWING_MIN_LOCATION_RELEVANCY
        )
    )
  );
}

/** A JobPost is in scope for evaluate iff it was in scope for viewing, viewing
 * has actually populated description + skillRequirements (the upstream
 * prerequisite), AND its location cleared the relevancy gate. Unviewed posts
 * are out-of-scope until viewing fills those columns; location-mismatched posts
 * are dropped here rather than being evaluated and shown to the user. */
export function inScopeForEvaluate(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return eb.and([
    inScopeForViewing(eb),
    eb('JobPost.description', 'is not', null),
    eb('JobPost.skillRequirements', 'is not', null),
    locationRelevancyInScope(eb),
  ]);
}

/** A JobPost is in scope for fill-form iff its source tree is active. Unlike
 * viewing, fill-form has no title-relevancy gate: it is triggered explicitly
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

/** A JobSource still needs sourcing iff ANY of the columns sourcing writes
 * is still null — `url`, `summary`, `interestScore`, `interestScoreReason`.
 * A row missing any one of these hasn't been fully processed by the
 * current sourcing flow. */
export function neededForSourcing(eb: ExpressionBuilder<DB, 'JobSource'>) {
  return eb.or([
    eb('JobSource.url', 'is', null),
    eb('JobSource.summary', 'is', null),
    eb('JobSource.interestScore', 'is', null),
    eb('JobSource.interestScoreReason', 'is', null),
  ]);
}
