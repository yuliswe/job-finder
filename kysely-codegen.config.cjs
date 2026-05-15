const Database = require('better-sqlite3');

const CUSTOM_TYPES = {
  text_datetime: 'Timestamp',
  integer_boolean: 'Bool',
};

function buildOverrides() {
  const dbPath = process.env.DB_PATH || 'jobs.db';
  const sqlite = new Database(dbPath, { readonly: true });
  const overrides = {};
  try {
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('kysely_migration', 'kysely_migration_lock')`
      )
      .all();
    for (const { name: tableName } of tables) {
      const cols = sqlite
        .prepare(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`)
        .all();
      for (const c of cols) {
        const mapped = CUSTOM_TYPES[String(c.type).toLowerCase()];
        if (!mapped) continue;
        const key = `${tableName}.${c.name}`;
        const hasDefault = c.dflt_value !== null && c.dflt_value !== 'NULL';
        const baseType = c.notnull ? mapped : `${mapped} | null`;
        overrides[key] = hasDefault ? `Generated<${baseType}>` : baseType;
      }
    }
  } finally {
    sqlite.close();
  }
  return overrides;
}

/** @type {import('kysely-codegen').Config} */
module.exports = {
  dialect: 'sqlite',
  outFile: '__generated__/db/types.ts',
  customImports: {
    Timestamp: 'src/db/customTypes#Timestamp',
    Bool: 'src/db/customTypes#Bool',
  },
  overrides: {
    columns: buildOverrides(),
  },
};
