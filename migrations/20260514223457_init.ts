import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('Job')
    .addColumn('id', 'integer', c => c.primaryKey().autoIncrement())
    .addColumn('title', 'text', c => c.notNull())
    .addColumn('company', 'text', c => c.notNull())
    .addColumn('url', 'text')
    .addColumn('location', 'text')
    .addColumn('createdAt', 'text', c =>
      c.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('Job').execute();
}
