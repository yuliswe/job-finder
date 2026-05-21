import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  // Rebuild SourceSeed so `name` is column-level UNIQUE (matching the style
  // of `url` on the same table and `name` on JobSource). SQLite has no
  // `ALTER COLUMN ADD UNIQUE`, so we use the standard table-recreate dance.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE "SourceSeed__new" (
      "id" text not null primary key,
      "createdAt" text_datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null,
      "updatedAt" text_datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null,
      "url" text not null unique,
      "name" text not null unique,
      "title" text not null
    )
  `.execute(db);

  await sql`
    INSERT INTO "SourceSeed__new" (id, createdAt, updatedAt, url, name, title)
    SELECT id, createdAt, updatedAt, url, name, title FROM "SourceSeed"
  `.execute(db);

  await sql`DROP TABLE "SourceSeed"`.execute(db);
  await sql`ALTER TABLE "SourceSeed__new" RENAME TO "SourceSeed"`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop UNIQUE on `name`. Same recreate dance, just without the constraint.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);

  await sql`
    CREATE TABLE "SourceSeed__old" (
      "id" text not null primary key,
      "createdAt" text_datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null,
      "updatedAt" text_datetime default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) not null,
      "url" text not null unique,
      "name" text not null,
      "title" text not null
    )
  `.execute(db);

  await sql`
    INSERT INTO "SourceSeed__old" (id, createdAt, updatedAt, url, name, title)
    SELECT id, createdAt, updatedAt, url, name, title FROM "SourceSeed"
  `.execute(db);

  await sql`DROP TABLE "SourceSeed"`.execute(db);
  await sql`ALTER TABLE "SourceSeed__old" RENAME TO "SourceSeed"`.execute(db);

  await sql`PRAGMA foreign_keys = ON`.execute(db);
}
