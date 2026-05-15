import { existsSync, writeFileSync } from 'node:fs';

import dotenv from 'dotenv';
import { OPENROUTER_API_KEY } from 'jobfinder.config';

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

  get DB_PATH() {
    return requiredEnvVar('DB_PATH', 'jobs.db');
  },
};
