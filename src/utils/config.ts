// Indirection layer between the application code and the user-facing
// `jobfinder.config.js`. All of `src/` imports its configuration from here
// rather than reaching into the root config file directly, so that the
// concrete file backing the configuration can be chosen at runtime.
//
// By default the configuration comes from the repo-root `jobfinder.config.js`
// (statically imported below; resolved by the build-time module-resolver alias
// and symlinked into `dist/` by `npm run build:assets`, so this works
// regardless of the current working directory). Setting the `CONFIG_FILE`
// environment variable overrides that with an arbitrary file, resolved
// against the directory `jobfinder` is run from, mirroring how `DATA_DIR` and
// other relative paths are resolved. The override file must be a plain
// JavaScript module of the same shape as `jobfinder.config.js` (see the
// `examples/` directory); it is loaded synchronously via `require`, which
// Node supports for ES modules that contain no top-level `await`.

import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';

import * as defaultConfig from 'jobfinder.config.js';

type Config = typeof defaultConfig;

/** Default when `CONFIG_FILE` is unset — matches the file the static import
 * above resolves to. Kept as a string only for the log/error messages. */
const DEFAULT_CONFIG_FILE = './jobfinder.config.js';

function loadConfigFile(file: string): Config {
  const abs = isAbsolute(file) ? file : resolve(process.cwd(), file);
  const require = createRequire(import.meta.url);
  try {
    return require(abs) as Config;
  } catch (err) {
    throw new Error(
      `Failed to load CONFIG_FILE=${JSON.stringify(file)} (resolved to ${abs}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

const override = process.env.CONFIG_FILE;
const config: Config =
  override && override !== DEFAULT_CONFIG_FILE
    ? loadConfigFile(override)
    : defaultConfig;

export const {
  OPENROUTER_API_KEY,
  ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN,
  SERPER_API_KEY,
  OLLAMA_HOST,
  AUTO_CHOOSE_NEXT_MODEL_AFTER_N_ATTEMPTS,
  LLM_REQUEST_CONCURRENCY_MAX,
  LLM_LOG_STREAM,
  DATA_DIR,
  DB_NAME,
  LLM_SEEDING_MODEL,
  LLM_SOURCING_MODEL,
  LLM_LISTING_MODEL,
  LLM_CODING_MODEL,
  LLM_VIEWING_MODEL,
  LLM_EVALUATION_MODEL,
  LLM_CV_TEMPLATE_MODEL,
  LLM_FILL_FORM_MODEL,
  RESUME_OUTPUT_DIR,
  USE_HEADLESS_BROWSER,
  MAX_CONCURRENT_BROWSER_TABS,
  BROWSER_NAVIGATION_TIMEOUT_MS,
  BROWSER_NAVIGATION_MIN_WAIT_MS,
  PIPELINE_LISTING_MIN_INTEREST_SCORE,
  PIPELINE_LISTING_BFS_MAX_DEPTH,
  PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE,
  PIPELINE_VIEWING_MIN_TITLE_RELEVANCY,
  PIPELINE_VIEWING_MIN_LOCATION_RELEVANCY,
  PIPELINE_RUN_SCRIPTS_SPAM_PREVENTION_JOB_COUNTS,
  TAGS,
  CLAUDE_CODE_CLI_BIN,
} = config;
