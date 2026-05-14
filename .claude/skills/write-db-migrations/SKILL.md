---
name: write-db-migrations
description: Author Kysely migrations for this project following its naming conventions and post-write workflow.
allowed-tools: [Bash, Read, Edit, Write, Grep, Glob]
---

# Write DB Migrations

Use this skill when adding or modifying database tables in this repo.

## Naming conventions

- **Table names:** PascalCase, singular. `Job`, `User`, `Application` — never `jobs`, `Users`, or `applications`.
- **Column names:** camelCase. `createdAt`, `firstName`, `companyId` — never `created_at` or `first_name`.
- **Standard columns** on most tables:
  - `id` — `integer`, primary key, autoincrement
  - `createdAt` — `text`, not null, default `CURRENT_TIMESTAMP`
  - `updatedAt` — `text`, not null, default `CURRENT_TIMESTAMP` (add a trigger or update in app code as needed)

## Workflow

1. **Scaffold** the migration file. Don't hand-create the timestamp:
   ```bash
   npm run db:migrate:create -- <descriptive_name>
   ```
   This writes `migrations/<UTC-timestamp>_<slug>.ts` with `up`/`down` stubs.

2. **Fill in** `up` and `down` using Kysely's schema builder. Both directions must be reversible.
   ```ts
   import { Kysely, sql } from 'kysely';

   export async function up(db: Kysely<unknown>): Promise<void> {
     await db.schema
       .createTable('Job')
       .addColumn('id', 'integer', c => c.primaryKey().autoIncrement())
       .addColumn('title', 'text', c => c.notNull())
       .addColumn('createdAt', 'text', c =>
         c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
       )
       .execute();
   }

   export async function down(db: Kysely<unknown>): Promise<void> {
     await db.schema.dropTable('Job').execute();
   }
   ```

3. **Apply** the migration:
   ```bash
   npm run db:migrate
   ```

4. **Regenerate** the type files (both required, in this order):
   ```bash
   npm run db:codegen         # → __generated__/db/types.ts
   npm run db:schema-review   # → __generated__/schema-review.ts
   ```

5. **Commit** the migration file and both generated files together.

## Editing existing migrations

**Do not** edit a migration after it has been applied. If the table/column name needs to change, write a **new** migration that uses `alterTable().renameTo()` / `renameColumn()`. Editing in place desyncs deployed environments — `down` won't find the old-named object.

The only exception: when iterating locally before the migration has ever been applied to anything shared. Even then, prefer dropping the dev DB file (`rm jobs.db*`) and re-running migrations cleanly.

## Quick reference for available scripts

- `npm run db:migrate` — apply all pending
- `npm run db:migrate:up` — apply one
- `npm run db:migrate:down` — roll back one
- `npm run db:reset` — roll back all
- `npm run db:migrate:create -- <name>` — scaffold new migration
- `npm run db:codegen` — regenerate Kysely types
- `npm run db:schema-review` — regenerate human-reviewable schema snapshot
