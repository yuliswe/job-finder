import { existsSync, writeFileSync } from 'node:fs';

import dotenv from 'dotenv';
import {
  ANTHROPIC_API_KEY,
  DB_PATH,
  LLM_PLUGIN,
  LLM_REQUEST_CONCURRENCY_MAX,
  OLLAMA_HOST,
  OPENROUTER_API_KEY,
  SERPER_API_KEY,
} from 'jobfinder.config.js';

const VALID_LLM_PLUGINS = ['openrouter', 'anthropic', 'ollama'] as const;
export type LlmPluginName = (typeof VALID_LLM_PLUGINS)[number];

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
    return requiredEnvVar('DB_PATH', DB_PATH);
  },

  /** Optional — only required by features that hit the Serper API (e.g.
   * `webSearchBySerper`). Returns `undefined` if neither `.env.local` nor
   * `jobfinder.config.js` populated it; callers decide whether that's fatal. */
  get SERPER_API_KEY(): string | undefined {
    return SERPER_API_KEY ?? process.env.SERPER_API_KEY;
  },

  /** Base URL of the local Ollama daemon. Only consulted when
   * `LLM_PLUGIN === 'ollama'`. Defaults to `http://localhost:11434` via
   * `jobfinder.config.js`. */
  get OLLAMA_HOST(): string {
    return process.env.OLLAMA_HOST ?? OLLAMA_HOST;
  },

  /** Which provider plugin handles every LLM call. See
   * `jobfinder.config.js#LLM_PLUGIN` for the documented choices. Throws
   * on an unrecognized value so a typo doesn't silently fall back. */
  get LLM_PLUGIN(): LlmPluginName {
    const raw = process.env.LLM_PLUGIN ?? LLM_PLUGIN;
    if ((VALID_LLM_PLUGINS as readonly string[]).includes(raw)) {
      return raw as LlmPluginName;
    }

    throw new Error(
      `LLM_PLUGIN=${JSON.stringify(raw)} is not one of ${VALID_LLM_PLUGINS.join(' / ')}.`
    );
  },

  /** User-configured cap on simultaneous LLM requests, or `undefined`
   * when unset (the caller may then pick a plugin-appropriate default —
   * see `resolveLlmConcurrency` in `src/llm/base.ts`). Env-var override
   * accepts a positive integer; anything else throws. */
  get LLM_REQUEST_CONCURRENCY_MAX(): number | undefined {
    const raw = process.env.LLM_REQUEST_CONCURRENCY_MAX;
    if (raw === undefined || raw === '') return LLM_REQUEST_CONCURRENCY_MAX;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `LLM_REQUEST_CONCURRENCY_MAX=${JSON.stringify(raw)} must be a positive integer (or unset for unlimited).`
      );
    }

    return n;
  },
};
