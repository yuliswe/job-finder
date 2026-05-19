import type { ExpressionBuilder } from 'kysely';

import type { DB } from '__generated__/db/types.js';
import { PIPELINE_VIEWING_MIN_TITLE_RELEVANCY } from 'jobfinder.config.js';
import {
  jobListSourceInActiveSource,
  jobPostInActiveSource,
} from 'src/db/activeSource.js';
import { Bool } from 'src/db/customTypes.js';

// Per-task "qualified" predicates: the conditions an entity must satisfy to
// even be considered for this pipeline task. Eligibility (queued/started) is
// orthogonal and applied via `eligibleForPipelineTask`. The CLI work-picker
// uses these.
//
// The TUI bar uses `inScopeForX` predicates below — pure scope filters with
// no work-status clauses. A bar denominator is the parent table's row count;
// rows that fail `inScopeForX` count as "out of scope" (rows we deliberately
// skip), while rows that pass partition into done/noResult/failed/queued by
// their latest pipeline state.

/** A SourceSeed counts for sourcing unless every JobSource matched by name is
 * inactive. Seeds with no produced source yet (or at least one active source)
 * remain qualified. */
export function qualifiedForSourcing(eb: ExpressionBuilder<DB, 'SourceSeed'>) {
  return eb.or([
    eb.not(
      eb.exists(
        eb
          .selectFrom('JobSource')
          .select('JobSource.id')
          .whereRef('JobSource.name', '=', 'SourceSeed.name')
      )
    ),
    eb.exists(
      eb
        .selectFrom('JobSource')
        .select('JobSource.id')
        .whereRef('JobSource.name', '=', 'SourceSeed.name')
        .where('JobSource.isActive', '=', Bool.True)
    ),
  ]);
}

/** A JobSource counts for listing when it's active AND either has no listing
 * yet (listing pending) or at least one of its listings is active. */
export function qualifiedForListing(eb: ExpressionBuilder<DB, 'JobSource'>) {
  return eb.and([
    eb('JobSource.isActive', '=', Bool.True),
    eb.or([
      eb.not(
        eb.exists(
          eb
            .selectFrom('JobListSource')
            .select('JobListSource.id')
            .whereRef('JobListSource.ofJobSourceId', '=', 'JobSource.id')
        )
      ),
      eb.exists(
        eb
          .selectFrom('JobListSource')
          .select('JobListSource.id')
          .whereRef('JobListSource.ofJobSourceId', '=', 'JobSource.id')
          .where('JobListSource.isActive', '=', Bool.True)
      ),
    ]),
  ]);
}

/** A JobListSource is qualified for scripting when it's in an active source
 * tree AND its parser script hasn't been generated yet. */
export function qualifiedForScripting(
  eb: ExpressionBuilder<DB, 'JobListSource'>
) {
  return eb.and([
    jobListSourceInActiveSource(eb),
    eb('JobListSource.parserScript', 'is', null),
  ]);
}

/** A JobListSource is qualified for run-scripts when it's in an active source
 * tree AND has a parser script. */
export function qualifiedForRunScripts(
  eb: ExpressionBuilder<DB, 'JobListSource'>
) {
  return eb.and([
    jobListSourceInActiveSource(eb),
    eb('JobListSource.parserScript', 'is not', null),
  ]);
}

/** A JobPost is qualified for viewing when its source tree is active AND its
 * title cleared the relevancy threshold. */
export function qualifiedForViewing(eb: ExpressionBuilder<DB, 'JobPost'>) {
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

/** A JobPost is qualified for evaluate when its source tree is active AND its
 * description + skillRequirements have been populated by `viewing`. */
export function qualifiedForEvaluate(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return eb.and([
    jobPostInActiveSource(eb),
    eb('JobPost.description', 'is not', null),
    eb('JobPost.skillRequirements', 'is not', null),
  ]);
}

// `inScopeForX` — pure scope predicates used by the TUI bar. Out-of-scope =
// parent-table rows we deliberately skip (inactive tree, below relevancy
// threshold). Status conditions (no upstream output yet, parserScript not set,
// description not viewed) do NOT belong here — they're segmented into
// done/noResult/failed/queued via LatestPipelineState.
//
// Seeding and sourcing have no skip rule (every SourceSeed is in scope), so
// they have no predicate here — the TUI bar just omits the scope filter.

/** A JobSource is in scope for listing iff it's active. */
export function inScopeForListing(eb: ExpressionBuilder<DB, 'JobSource'>) {
  return eb('JobSource.isActive', '=', Bool.True);
}

/** A JobListSource is in scope for scripting iff it's in an active source
 * tree. */
export function inScopeForScripting(
  eb: ExpressionBuilder<DB, 'JobListSource'>
) {
  return jobListSourceInActiveSource(eb);
}

/** A JobListSource is in scope for run-scripts iff it's in an active source
 * tree. */
export function inScopeForRunScripts(
  eb: ExpressionBuilder<DB, 'JobListSource'>
) {
  return jobListSourceInActiveSource(eb);
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

/** A JobPost is in scope for evaluate iff it was in scope for viewing — an
 * un-viewable post can't be evaluated. */
export function inScopeForEvaluate(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return inScopeForViewing(eb);
}
