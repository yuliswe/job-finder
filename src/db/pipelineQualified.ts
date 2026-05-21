import { sql, type ExpressionBuilder, type SqlBool } from 'kysely';

import type { DB } from '__generated__/db/types.js';
import { PIPELINE_VIEWING_MIN_TITLE_RELEVANCY } from 'jobfinder.config.js';
import {
  jobListSourceInActiveSource,
  jobPostInActiveSource,
} from 'src/db/activeSource.js';
import { Bool } from 'src/db/customTypes.js';

// ─────────────────────────────────────────────────────────────────────────
// `qualifiedForX` vs `inScopeForX` — read this before touching either.
// ─────────────────────────────────────────────────────────────────────────
//
// Both are SQL predicates over the task's parent table (e.g. JobListSource
// for scripting). They answer related but distinct questions:
//
//   `qualifiedForX(row)`   — Does this row have the DATA the task needs to
//                            run? Only checks upstream-prereq columns. Does
//                            NOT check active-tree, design-time skip rules,
//                            or pipeline state. For tasks with no row-level
//                            prereq (most of them), this is trivially true.
//
//   `inScopeForX(row)`     — SHOULD the pipeline ever touch this row?
//                            Active-tree membership + design-time skip rules
//                            (e.g. relevancy threshold). Independent of
//                            qualified/state.
//
// The two are orthogonal. A row that's `qualified` may be out-of-scope (e.g.
// a JobListSource with `parserScript` set but its tree was toggled off — run-
// scripts won't process it). A row that's `inScope` may not be `qualified`
// (e.g. a JobListSource in an active tree but `parserScript IS NULL` — run-
// scripts can't process it until scripting fills the column in).
//
// The "universe of work" for a task is `qualifiedForX(row) AND
// inScopeForX(row)`. The CLI's three modes layer different pipeline-state
// filters on top:
//
//   no flag           → `needs ∩ {state ∈ queued / user_interrupted}`
//   --include-failed  → `needs ∩ {state ≠ done}`
//   --all             → `needs` (any state — re-process done rows too)
//
// where `needs = qualifiedForX ∩ inScopeForX`. These nest:
// no-flag ⊆ --include-failed ⊆ --all.
//
// ── Worked example (scripting) ──────────────────────────────────────────
// Scripting has no row-level prereq, so `qualifiedForScripting` is
// trivially true. Suppose JobListSource has 5 rows in an active tree:
//
//   id  parserScript  latest scripting state
//   ──  ────────────  ──────────────────────
//   A   "function…"   done
//   B   "function…"   done
//   C   NULL          queued
//   D   NULL          aborted
//   E   NULL          (no row yet)
//
// All 5 are `qualified` (no prereq) and `inScope` (active tree). So `needs`
// = {A, B, C, D, E}. The CLI modes pick subsets via pipeline state:
//   no flag           → {C}              (only queued)
//   --include-failed  → {C, D, E}        (queued/aborted/no-row → not done)
//   --all             → {A, B, C, D, E}  (re-script A and B too,
//                                         overwriting their parserScript)
//
// The TUI bar reads `inScopeForX` as its denominator: 5 rows, 2 done
// (green) + 3 pending (empty).
//
// ── Worked example (evaluate) ───────────────────────────────────────────
// Evaluate's prereq is upstream's output: viewing must have populated
// `description` and `skillRequirements`. Suppose JobPost has 4 rows:
//
//   id  titleRelevancy  description    skillReq    evaluate state
//   ──  ──────────────  ────────────   ─────────   ──────────────
//   P   0.9             "Senior eng…"  non-null    done
//   Q   0.9             "Backend…"     non-null    queued
//   R   0.9             NULL           NULL        (no row yet)
//   S   0.1             NULL           NULL        (no row yet)
//
// `qualifiedForEvaluate`  → {P, Q}  (R, S fail description+skillReq prereq)
// `inScopeForEvaluate`    → {P, Q}  (S out-of-scope by titleRelevancy)
//                                    (R out-of-scope because the bar's scope
//                                    treats unviewed posts as out-of-scope
//                                    until they make it past viewing)
// `needs`                 → {P, Q}
//
// Mode behavior:
//   no flag           → {Q}        (only queued)
//   --include-failed  → {Q}        (P is done — skipped)
//   --all             → {P, Q}     (re-evaluate P too)
//
// ── Rule of thumb ───────────────────────────────────────────────────────
// Adding a "is this row already done?" check to `qualifiedForX` is a smell.
// That's a pipeline-state concern, applied by the CLI mode filter, not by
// the row predicate.

/** `1` rendered as a SqlBool so the trivial qualifiedForX predicates can be
 * used wherever a boolean expression is expected. */
const ALWAYS_TRUE = sql<SqlBool>`1`;

/** Seeding has no row-level data prereq — every SourceSeed is qualified. */
export function qualifiedForSeeding(_eb: ExpressionBuilder<DB, 'SourceSeed'>) {
  return ALWAYS_TRUE;
}

/** Sourcing operates on JobSource rows that approve-seeds promoted from
 * SourceSeed by name. The row-level data prereq is `url IS NULL` — once
 * sourcing fills the URL in, there's nothing left for this task to do. */
export function qualifiedForSourcing(eb: ExpressionBuilder<DB, 'JobSource'>) {
  return eb('JobSource.url', 'is', null);
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
  return eb('JobSource.isActive', '=', Bool.True);
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

/** A JobPost is in scope for viewing iff its tree is active AND its title
 * cleared the relevancy threshold (low-relevancy posts are skipped by
 * design). */
export function inScopeForViewing(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return eb.and([
    jobPostInActiveSource(eb),
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

/** A JobPost is in scope for evaluate iff it was in scope for viewing AND
 * viewing has actually populated description + skillRequirements (the
 * upstream prerequisite). Unviewed posts are out-of-scope until viewing
 * fills those columns. */
export function inScopeForEvaluate(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return eb.and([
    inScopeForViewing(eb),
    eb('JobPost.description', 'is not', null),
    eb('JobPost.skillRequirements', 'is not', null),
  ]);
}
