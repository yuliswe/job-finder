import { Kysely, sql } from 'kysely';

import { Bool } from 'src/db/customTypes.js';

// A user-settable per-post scope override. `isManuallyExcluded = 1` pushes the
// post out of scope for viewing/evaluate exactly as a below-threshold relevancy
// score would, and `manualExclusionReason` records the note the user (or the
// TUI) attached. Scope was previously derived entirely from active-tree
// membership and LLM relevancy scores; this is the first stored signal a human
// controls directly. See `notManuallyExcluded` in src/db/pipelineQualified.ts.

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable('JobPost')
    .addColumn('isManuallyExcluded', sql`integer_boolean`, c =>
      c.notNull().defaultTo(Bool.False)
    )
    .execute();

  await db.schema
    .alterTable('JobPost')
    .addColumn('manualExclusionReason', 'text')
    .execute();

  await db.schema
    .createIndex('JobPost_isManuallyExcluded_idx')
    .on('JobPost')
    .column('isManuallyExcluded')
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex('JobPost_isManuallyExcluded_idx').execute();

  await db.schema
    .alterTable('JobPost')
    .dropColumn('manualExclusionReason')
    .execute();

  await db.schema
    .alterTable('JobPost')
    .dropColumn('isManuallyExcluded')
    .execute();
}
