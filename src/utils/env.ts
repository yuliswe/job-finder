import { existsSync, writeFileSync } from 'node:fs';

import dotenv from 'dotenv';
import {
  ANTHROPIC_API_KEY,
  DB_PATH,
  LLM_LOG_STREAM,
  LLM_REQUEST_CONCURRENCY_MAX,
  OLLAMA_HOST,
  OPENROUTER_API_KEY,
  SERPER_API_KEY,
  TAGS,
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
    return requiredEnvVar('DB_PATH', DB_PATH);
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
