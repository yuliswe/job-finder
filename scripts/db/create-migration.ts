import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationFolder = path.resolve(__dirname, '../../migrations');

const TEMPLATE = `import { Kysely, sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // TODO: write migration
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // TODO: revert migration
}
`;

function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function timestamp(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

const program = new Command();

program
  .name('db:migrate:create')
  .description('Create a new Kysely migration file')
  .argument('<name>', 'Migration name (will be slugified)')
  .action(async (name: string) => {
    const slug = slugify(name);
    if (!slug) {
      console.error('Migration name must contain alphanumeric characters');
      process.exit(1);
    }

    const filename = `${timestamp()}_${slug}.ts`;
    const filepath = path.join(migrationFolder, filename);

    await fs.mkdir(migrationFolder, { recursive: true });
    await fs.writeFile(filepath, TEMPLATE, { flag: 'wx' });
    console.info(`Created ${path.relative(process.cwd(), filepath)}`);
  });

void (async () => {
  await program.parseAsync();
  process.exit(0);
})();
