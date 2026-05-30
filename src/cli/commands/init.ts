import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { FileMigrationProvider, Migrator } from 'kysely';

import { db, sqlite } from 'src/db/index.js';
import { Env } from 'src/utils/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_FOLDER = path.resolve(__dirname, '../../../migrations');

export function createInitCommand(): Command {
  return new Command('init')
    .description('Create the SQLite DB and apply all migrations')
    .action(runInit);
}

async function runInit(): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder: MIGRATION_FOLDER,
    }),
  });

  try {
    const { error, results } = await migrator.migrateToLatest();

    for (const r of results ?? []) {
      if (r.status === 'Success') {
        console.info(`✓ ${r.direction} ${r.migrationName}`);
      } else if (r.status === 'Error') {
        console.error(`✗ ${r.direction} ${r.migrationName}`);
      }
    }

    if (error) throw error;

    console.info(`DB ready at ${Env.DB_PATH}`);
  } finally {
    await db.destroy();
    sqlite.close();
  }
}
