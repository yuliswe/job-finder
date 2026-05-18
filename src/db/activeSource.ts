import type { ExpressionBuilder } from 'kysely';

import type { DB } from '__generated__/db/types.js';
import { Bool } from 'src/db/customTypes.js';

// "Active source" is the single source of truth for whether downstream pipeline
// work should run / be counted: the JobSource (and JobListSource, where one
// exists) must have isActive = 1. These helpers express that rule against
// JobPost, JobListSource, and JobSource scopes so callers don't reinvent it.

/** True iff the JobPost's source — and list source, if any — are active. */
export function jobPostInActiveSource(eb: ExpressionBuilder<DB, 'JobPost'>) {
  return eb.and([
    eb.exists(
      eb
        .selectFrom('JobSource')
        .select('JobSource.id')
        .whereRef('JobSource.id', '=', 'JobPost.ofJobSourceId')
        .where('JobSource.isActive', '=', Bool.True)
    ),
    eb.or([
      eb('JobPost.ofJobListSourceId', 'is', null),
      eb.exists(
        eb
          .selectFrom('JobListSource')
          .select('JobListSource.id')
          .whereRef('JobListSource.id', '=', 'JobPost.ofJobListSourceId')
          .where('JobListSource.isActive', '=', Bool.True)
      ),
    ]),
  ]);
}

/** True iff the JobListSource and its parent JobSource are both active. */
export function jobListSourceInActiveSource(
  eb: ExpressionBuilder<DB, 'JobListSource'>
) {
  return eb.and([
    eb('JobListSource.isActive', '=', Bool.True),
    eb.exists(
      eb
        .selectFrom('JobSource')
        .select('JobSource.id')
        .whereRef('JobSource.id', '=', 'JobListSource.ofJobSourceId')
        .where('JobSource.isActive', '=', Bool.True)
    ),
  ]);
}
