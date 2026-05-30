#!/usr/bin/env node
/* eslint-disable no-console */
//
// Drives `npm run build` on file changes and prints which files triggered
// each rebuild — the bare `nodemon` CLI silently fires `[nodemon] restarting
// due to changes...` with no detail, which makes "did my edit take?"
// impossible to verify without a verbose flag. This script wraps the
// nodemon Node API so we can hook `restart` and log the file list.
//
// Run via `npm start` (which delegates here). Stops on Ctrl-C.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import nodemon from 'nodemon';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

nodemon({
  exec: 'npm run build',
  // Mirrors the previous nodemon.json. `tsx` is in `ext` so TUI component
  // edits actually fire a rebuild (the original config silently dropped them).
  watch: ['src', '*.yml', '*.graphql', '*.json', '*.js'],
  ext: 'js,ts,tsx,graphql,yml,yaml,json',
  ignore: [
    '__generated__/**',
    'src/__generated__/**',
    '**/node_modules/**',
    '**/build/**',
    '**/dist/**',
  ],
  signal: 'SIGINT',
});

nodemon
  .on('start', () => {
    console.log('[build-watch] starting initial build…');
  })
  .on('restart', files => {
    const list = Array.isArray(files) && files.length > 0 ? files : null;
    if (list) {
      const rel = list.map(f => path.relative(repoRoot, f));
      console.log(`\n[build-watch] rebuild — ${rel.length} file(s) changed:`);
      for (const f of rel) console.log(`  • ${f}`);
      console.log('');
    } else {
      console.log('\n[build-watch] rebuild — (manual restart)\n');
    }
  })
  .on('crash', () => {
    console.error(
      '[build-watch] build crashed; waiting for changes before retry'
    );
  })
  .on('quit', () => {
    console.log('[build-watch] exiting');
    process.exit(0);
  });

process.on('SIGINT', () => nodemon.emit('quit'));
process.on('SIGTERM', () => nodemon.emit('quit'));
