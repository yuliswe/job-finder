---
name: dev-query-db
description: Run ad-hoc read queries against the project's SQLite DB without writing throwaway scripts.
allowed-tools: [Bash, Read, Grep, Glob]
---

# Query the DB

Use this skill when you need a quick count, sample, or sanity check against the project database (e.g. "how many JobPost rows are missing X", "show the latest PipelineState rows for foo").

## Where the DB lives

- SQLite file at `DATA_DIR/DB_NAME` (default `./data/jobs.db`, relative to repo root). Both are set in `jobfinder.config.js`; the path is always composed as `DATA_DIR/DB_NAME`, so there is no independent `DB_PATH` override.
- Same file is used by tests and by the running CLI — assume it's hot. Don't write to it from here.
- WAL mode is on, so `jobs.db-wal` / `jobs.db-shm` are normal.

## Where the schema lives

- Kysely types: `__generated__/db/types.ts` — authoritative for column names/nullability.
- Annotated review: `__generated__/schema-review.ts` — easier to read for FKs, indexes, and defaults.
- Custom column types (e.g. `Bool`): `src/db/customTypes.ts`. Booleans are stored as 0/1 — use `=` against `0`/`1`, not `true`/`false`.

## How to run a query

**Preferred — `sqlite3` CLI for one-shot reads:**

```bash
sqlite3 data/jobs.db "SELECT COUNT(*) FROM JobPost WHERE description IS NULL;"
```

For multi-column output, add `-header -column`:

```bash
sqlite3 -header -column data/jobs.db "SELECT id, title FROM JobPost LIMIT 5;"
```

JSON output:

```bash
sqlite3 data/jobs.db ".mode json" "SELECT id, title FROM JobPost LIMIT 5;"
```

**Do not** write `.tmp_*.{ts,js,mjs,py}` scripts to run a query — use the CLI inline. (Per project convention; throwaway scripts are not welcome.)

## Naming/convention reminders

- Table names are PascalCase singular (`JobPost`, `JobSource`, `JobListSource`, `JobPostEval`, `SourceSeed`, `PipelineState`).
- Foreign-key columns are `ofXyzId` (e.g. `JobPost.ofJobListSourceId`).
- "Processed" flags are `isProcessed` (Bool, 0/1).
- "Overall score" on JobPost is computed (`src/tui/queries.ts` → `combine()`), not a column. It is non-null iff at least one of `JobPostEval.interestScore`, `skillScore`, `titleRelavency` is non-null.
