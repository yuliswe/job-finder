import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import dotenv from 'dotenv';
import {
  ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN,
  DATA_DIR,
  DB_NAME,
  LLM_LOG_STREAM,
  LLM_REQUEST_CONCURRENCY_MAX,
  OLLAMA_HOST,
  OPENROUTER_API_KEY,
  SERPER_API_KEY,
  TAGS,
} from 'jobfinder.config.js';

const ENV_PATH = '.env';
const ENV_LOCAL_PATH = '.env.local';
const REQUIRED_VARS = ['OPENROUTER_API_KEY'] as const;

function createEnvFileIfNotExists(path: string, vars: readonly string[]): void {
  if (!existsSync(path)) {
    writeFileSync(path, vars.map(v => `${v}=`).join('\n') + '\n');
  }
}

/** Loads `.env.local` first and `.env` second via `dotenv.config`, which
 * never overwrites a variable that is already set, so the effective
 * precedence is shell > `.env.local` > `.env`. Empty entries in
 * `.env.local` (the stubs written by `createEnvFileIfNotExists`) are
 * removed again before `.env` loads so that a blank stub cannot block a
 * real `.env` value. A warning is printed whenever `.env.local` shadows
 * a `.env` key with a different value. */
function loadEnv(): void {
  const local =
    dotenv.config({ path: ENV_LOCAL_PATH, quiet: true }).parsed ?? {};

  for (const [key, value] of Object.entries(local)) {
    if (value === '' && process.env[key] === '') {
      delete process.env[key];
    }
  }

  const base = dotenv.config({ path: ENV_PATH, quiet: true }).parsed ?? {};

  for (const [key, value] of Object.entries(local)) {
    if (value !== '' && key in base && base[key] !== value) {
      console.warn(`[env] ${ENV_LOCAL_PATH} overrides ${key} from ${ENV_PATH}`);
    }
  }
}

createEnvFileIfNotExists(ENV_LOCAL_PATH, REQUIRED_VARS);
loadEnv();

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

  /** Optional — only required by features that hit the Anthropic API
   * (i.e. any `LLM_*_MODEL` entry prefixed `anthropic-plugin/`). Returns
   * `undefined` if neither `.env.local` nor `jobfinder.config.js`
   * populated it; `AnthropicSdkPlugin.getClient` throws on first use if
   * `ANTHROPIC_AUTH_TOKEN` is also unset. */
  get ANTHROPIC_API_KEY(): string | undefined {
    return process.env.ANTHROPIC_API_KEY || ANTHROPIC_API_KEY || undefined;
  },

  /** Optional OAuth bearer token, used as an alternative to
   * `ANTHROPIC_API_KEY` for Claude Pro/Max subscription access. Mint
   * one with `claude setup-token`. The SDK sends it as
   * `Authorization: Bearer …` instead of `x-api-key`. Returns
   * `undefined` if neither `.env.local` nor `jobfinder.config.js`
   * populated it. */
  get ANTHROPIC_AUTH_TOKEN(): string | undefined {
    return (
      process.env.ANTHROPIC_AUTH_TOKEN || ANTHROPIC_AUTH_TOKEN || undefined
    );
  },

  /** Absolute-or-relative path to the SQLite database file, always
   * composed as `DATA_DIR/DB_NAME` (see `jobfinder.config.js`). There is
   * no independent `DB_PATH` override: the database is pinned inside the
   * data directory. `DB_NAME` must be a bare file name — a value with a
   * path separator (which could escape `DATA_DIR`) throws. */
  get DB_PATH(): string {
    if (DB_NAME !== basename(DB_NAME)) {
      throw new Error(
        `DB_NAME=${JSON.stringify(DB_NAME)} must be a bare file name without path separators; the database always lives at DATA_DIR/DB_NAME.`
      );
    }

    return join(DATA_DIR, DB_NAME);
  },

  /** Optional — only required by features that hit the Serper API (e.g.
   * `webSearchBySerper`). Returns `undefined` if neither `.env.local` nor
   * `jobfinder.config.js` populated it; callers decide whether that's fatal. */
  get SERPER_API_KEY(): string | undefined {
    return SERPER_API_KEY ?? process.env.SERPER_API_KEY;
  },

  /** Base URL of the local Ollama daemon. Only consulted by models
   * prefixed with `ollama-plugin/`. Defaults to `http://localhost:11434`
   * via `jobfinder.config.js`. */
  get OLLAMA_HOST(): string {
    return process.env.OLLAMA_HOST ?? OLLAMA_HOST;
  },

  /** User-defined color tags for JobPosts. See `jobfinder.config.js#TAGS`.
   * Keys are color identifiers stored in `JobPost.tags`; values are
   * display labels. Defaults to the five Ink-friendly colors. */
  get TAGS(): Record<string, string> {
    return TAGS ?? {};
  },

  /** When true, plugins that support streaming write the response (and
   * any `thinking` field) to stdout as it arrives. See
   * `jobfinder.config.js#LLM_LOG_STREAM`. Env-var override accepts
   * "true"/"1" or "false"/"0"; anything else throws. */
  get LLM_LOG_STREAM(): boolean {
    const raw = process.env.LLM_LOG_STREAM;
    if (raw === undefined || raw === '') return LLM_LOG_STREAM ?? false;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new Error(
      `LLM_LOG_STREAM=${JSON.stringify(raw)} must be one of true / false / 1 / 0.`
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
