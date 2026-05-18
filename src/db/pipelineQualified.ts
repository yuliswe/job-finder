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
// orthogonal and applied via `eligibleForPipelineTask`. These predicates are
// the single source of truth shared between the pipeline runner (which picks
// work) and the TUI bar (which counts the universe of work for the task), so
// the two views can never drift.

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
 * description has been populated by `viewing`. */
export function qualifiedForEvaluate(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return eb.and([
    jobPostInActiveSource(eb),
    eb('JobPost.description', 'is not', null),
  ]);
}
