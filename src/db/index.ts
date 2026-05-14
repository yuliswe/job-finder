import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { DB } from '__generated__/db/types.js';

const DB_PATH = process.env.DB_PATH ?? 'jobs.db';

export const sqlite: InstanceType<typeof Database> = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = new Kysely<DB>({
  dialect: new SqliteDialect({ database: sqlite }),
});
