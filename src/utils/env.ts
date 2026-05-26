import { existsSync, writeFileSync } from 'node:fs';

import dotenv from 'dotenv';
import {
  ANTHROPIC_API_KEY,
  OPENROUTER_API_KEY,
  SERPER_API_KEY,
} from 'jobfinder.config.js';

const ENV_PATH = '.env.local';
const REQUIRED_VARS = ['OPENROUTER_API_KEY', 'DB_PATH'] as const;

function createEnvFileIfNotExists(path: string, vars: readonly string[]): void {
  if (!existsSync(path)) {
    writeFileSync(path, vars.map(v => `${v}=`).join('\n') + '\n');
  }
}

createEnvFileIfNotExists(ENV_PATH, REQUIRED_VARS);
dotenv.config({ path: ENV_PATH, quiet: true });

function requiredEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name] ?? defaultValue;
  if (!value) {
    throw new Error(`Environment variable ${name} is required but not set`);
  }

  return value;
}

export const Env = {
  get OPENROUTER_API_KEY() {
    return requiredEnvVar('OPENROUTER_API_KEY', OPENROUTER_API_KEY);
  },

  get ANTHROPIC_API_KEY() {
    return requiredEnvVar('ANTHROPIC_API_KEY', ANTHROPIC_API_KEY);
  },

  get DB_PATH() {
    return requiredEnvVar('DB_PATH', 'jobs.db');
  },

  /** Optional — only required by features that hit the Serper API (e.g.
   * `webSearchBySerper`). Returns `undefined` if neither `.env.local` nor
   * `jobfinder.config.js` populated it; callers decide whether that's fatal. */
  get SERPER_API_KEY(): string | undefined {
    return SERPER_API_KEY ?? process.env.SERPER_API_KEY;
  },
};
