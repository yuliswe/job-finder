import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Rebuild JobSource to drop NOT NULL on `url` and add UNIQUE on `name`.
  // SQLite has no `ALTER COLUMN DROP NOT NULL`, so we use the standard
  // table-recreate dance. FKs from JobListSource / JobPost / PipelineState
  // target JobSource.id, which is preserved by the copy.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE "JobSource__new" (
      "id" text not null primary key,
      "createdAt" text_datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null,
      "updatedAt" text_datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null,
      "name" text not null unique,
      "url" text unique,
      "isActive" integer_boolean default 1 not null
    )
  `.execute(db);

  await sql`
    INSERT INTO "JobSource__new" (id, createdAt, updatedAt, name, url, isActive)
    SELECT id, createdAt, updatedAt, name, url, isActive FROM "JobSource"
  `.execute(db);

  await sql`DROP TABLE "JobSource"`.execute(db);
  await sql`ALTER TABLE "JobSource__new" RENAME TO "JobSource"`.execute(db);

  await db.schema
    .createIndex('JobSource_isActive_idx')
    .on('JobSource')
    .column('isActive')
    .execute();

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Restores NOT NULL on `url` and drops UNIQUE on `name`. Will fail if any
  // JobSource now has a NULL url — caller must clean those up before
  // rolling back. The 6 deleted duplicate rows are NOT restored.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE "JobSource__old" (
      "id" text not null primary key,
      "createdAt" text_datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null,
      "updatedAt" text_datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null,
      "name" text not null,
      "url" text not null unique,
      "isActive" integer_boolean default 1 not null
    )
  `.execute(db);

  await sql`
    INSERT INTO "JobSource__old" (id, createdAt, updatedAt, name, url, isActive)
    SELECT id, createdAt, updatedAt, name, url, isActive FROM "JobSource"
  `.execute(db);

  await sql`DROP TABLE "JobSource"`.execute(db);
  await sql`ALTER TABLE "JobSource__old" RENAME TO "JobSource"`.execute(db);

  await db.schema
    .createIndex('JobSource_isActive_idx')
    .on('JobSource')
    .column('isActive')
    .execute();

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
