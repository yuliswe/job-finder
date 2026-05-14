import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileMigrationProvider, Migrator, NO_MIGRATIONS } from 'kysely';
import { db, sqlite } from 'src/db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationFolder = path.resolve(__dirname, '../../migrations');

const migrator = new Migrator({
  db,
  provider: new FileMigrationProvider({ fs, path, migrationFolder }),
});

async function run() {
  const cmd = process.argv[2] ?? 'latest';

  const { error, results } =
    cmd === 'down'
      ? await migrator.migrateDown()
      : cmd === 'up'
        ? await migrator.migrateUp()
        : cmd === 'reset'
          ? await migrator.migrateTo(NO_MIGRATIONS)
          : await migrator.migrateToLatest();

  for (const r of results ?? []) {
    if (r.status === 'Success') {
      console.info(`✓ ${r.direction} ${r.migrationName}`);
    } else if (r.status === 'Error') {
      console.error(`✗ ${r.direction} ${r.migrationName}`);
    }
  }

  if (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

try {
  await run();
} finally {
  await db.destroy();
  sqlite.close();
}
