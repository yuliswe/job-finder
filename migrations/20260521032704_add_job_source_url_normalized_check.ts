import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Recreate JobSource with a CHECK constraint that enforces the
  // normalized-url invariant: `url` must NOT start with `http://`,
  // `https://`, or `www.`. The application-side `normalizeJobSourceUrl`
  // helper already produces this shape; the CHECK is the safety net for
  // any code path that bypasses the helper.
  //
  // SQLite has no `ALTER TABLE ADD CHECK`, so we use the standard
  // table-recreate dance.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE "JobSource__new" (
      "id" text not null primary key,
      "createdAt" text_datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null,
      "updatedAt" text_datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null,
      "name" text not null unique,
      "url" text unique CHECK (url IS NULL OR (url NOT LIKE 'http%' AND url NOT LIKE 'www.%')),
      "isActive" integer_boolean default 1 not null,
      "summary" text,
      "interestScore" real,
      "interestScoreReason" text
    )
  `.execute(db);

  await sql`
    INSERT INTO "JobSource__new"
      (id, createdAt, updatedAt, name, url, isActive, summary, interestScore, interestScoreReason)
    SELECT
      id, createdAt, updatedAt, name, url, isActive, summary, interestScore, interestScoreReason
    FROM "JobSource"
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
  // Drop the CHECK. Same recreate dance, just without the constraint.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE "JobSource__old" (
      "id" text not null primary key,
      "createdAt" text_datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null,
      "updatedAt" text_datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null,
      "name" text not null unique,
      "url" text unique,
      "isActive" integer_boolean default 1 not null,
      "summary" text,
      "interestScore" real,
      "interestScoreReason" text
    )
  `.execute(db);

  await sql`
    INSERT INTO "JobSource__old"
      (id, createdAt, updatedAt, name, url, isActive, summary, interestScore, interestScoreReason)
    SELECT
      id, createdAt, updatedAt, name, url, isActive, summary, interestScore, interestScoreReason
    FROM "JobSource"
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
