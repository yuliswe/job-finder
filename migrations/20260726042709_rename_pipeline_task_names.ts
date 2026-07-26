import { Kysely, sql } from 'kysely';

// Seven pipeline stages were renamed in the code:
//   seeding      → explore-hiring-companies
//   sourcing     → research-company
//   listing      → identify-job-list-url
//   scripting    → learn-to-use-job-list
//   run-scripts  → apply-filters
//   viewing      → view-job-detail
//   evaluate     → evaluate-skill-match
//
// The stage name is stored as data in the `task` text column of both
// `PipelineState` (append-only history) and `PipelineTrigger` (one row per
// task/entity), so existing rows still carry the old names. Rewrite them in
// place so the renamed pickers keep matching the history a prior run wrote. The
// column is plain `text` with no CHECK constraint, so a value UPDATE suffices.
//
// `PipelineTrigger` is guarded by an existence check: some databases have the
// `add_pipeline_trigger` migration recorded as applied but no longer carry the
// table itself, so an unconditional UPDATE would throw "no such table" and abort
// an otherwise valid rename. The rename is skipped where the table is absent.

const RENAMES: ReadonlyArray<readonly [old: string, next: string]> = [
  ['seeding', 'explore-hiring-companies'],
  ['sourcing', 'research-company'],
  ['listing', 'identify-job-list-url'],
  ['scripting', 'learn-to-use-job-list'],
  ['run-scripts', 'apply-filters'],
  ['viewing', 'view-job-detail'],
  ['evaluate', 'evaluate-skill-match'],
];

async function tableExists(
  db: Kysely<unknown>,
  name: string
): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}
  `.execute(db);

  return result.rows.length > 0;
}

async function renameTasks(
  db: Kysely<unknown>,
  from: string,
  to: string
): Promise<void> {
  for (const table of ['PipelineState', 'PipelineTrigger'] as const) {
    if (!(await tableExists(db, table))) continue;

    await sql`
      UPDATE ${sql.ref(table)} SET task = ${to} WHERE task = ${from}
    `.execute(db);
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const [from, to] of RENAMES) await renameTasks(db, from, to);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const [from, to] of RENAMES) await renameTasks(db, to, from);
}
