// This file is intentionally plain JavaScript so users can edit it without
// running a build. It is symlinked into `dist/` by `npm run build:assets`,
// so changes here take effect on the very next CLI run.
//
// Do NOT add imports that depend on the build-time module-resolver alias
// (e.g. `'src/foo.js'`) — at runtime this file lives at the repo root and
// Node ESM has no such alias. Keep this file to plain literals + env reads.
//
// This example routes the LLM stages through the local Claude Code CLI
// (`ClaudeCodeCliPlugin`), so requests bill against the machine's Claude
// Pro/Max **subscription** rather than an API key. The CLI already holds the
// OAuth login in the OS keychain, so no `ANTHROPIC_API_KEY` /
// `ANTHROPIC_AUTH_TOKEN` is needed for the `claudecode-plugin/` models below.

/**
 * Path (or bare name resolved via PATH) of the Claude Code CLI binary that
 * `ClaudeCodeCliPlugin` shells out to. The plugin runs `claude -p`, so
 * requests bill against the machine's Claude subscription. Leave unset to use
 * `claude` from PATH; override when the binary lives elsewhere (e.g.
 * `'/opt/homebrew/bin/claude'`). If not set, will fall back to env var.
 */
export const CLAUDE_CODE_CLI_BIN = process.env.CLAUDE_CODE_CLI_BIN;

/**
 * The OpenRouter API key to use for the LLM calls. Needed here only because
 * the sourcing stage requests `enableWebSearch`, which the Claude Code CLI
 * plugin does not support (it disables all tools for deterministic output and
 * throws). `LLM_SOURCING_MODEL` below therefore points at OpenRouter. If not
 * set, will fall back to env var.
 */
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

/**
 * The Anthropic API key to use for the LLM calls. Not required by this config
 * (the `claudecode-plugin/` models bill via the subscription), but kept here
 * so you can switch a stage back to `anthropic-plugin/` without editing the
 * exports. If not set, will fall back to env var.
 */
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * OAuth bearer token for Claude Pro/Max subscription access (mint one
 * with `claude setup-token`). Used only by `anthropic-plugin/` models, not by
 * the Claude Code CLI plugin (which reads the CLI's own keychain login). If
 * not set, will fall back to env var.
 */
export const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;

/**
 * Serper API key (https://serper.dev). Used by `webSearchBySerper` to fetch
 * Google search results as structured JSON without driving a browser tab.
 */
export const SERPER_API_KEY = process.env.SERPER_API_KEY;

/**
 * Base URL of the local Ollama daemon, consulted by any model prefixed
 * with `ollama-plugin/`. Default: `'http://localhost:11434'` (Ollama's
 * default port). Override via `OLLAMA_HOST` env var to point at a
 * remote daemon.
 */
export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

/**
 * Cap on simultaneous in-flight LLM requests, applied per plugin.
 * `undefined` (default) = unlimited. Each `claudecode-plugin/` call spawns a
 * `claude -p` subprocess, so set a small integer here if fanning the pipeline
 * out spawns more CLI processes than the machine can comfortably run.
 */
export const LLM_REQUEST_CONCURRENCY_MAX = undefined;

/**
 * When true, echo the model's final output to stdout after each call. The
 * Claude Code CLI plugin uses the `json` output format (a single blob, not a
 * live stream), so this prints the completed text rather than streaming
 * deltas.
 */
export const LLM_LOG_STREAM = false;

/**
 * Per-model attempt budget inside `llmSend`. Each `LLM_*_MODEL` value is
 * an array; `llmSend` retries the current model up to this many times
 * before advancing to the next model in the array. When every model is
 * exhausted, `llmSend` throws the last error.
 */
export const AUTO_CHOOSE_NEXT_MODEL_AFTER_N_ATTEMPTS = 3;

/**
 * Directory holding the user's data — the seed inputs (`interests.md`,
 * `cv.md`, and their gitignored `*.local.md` overrides) plus the SQLite
 * database file named by `DB_NAME`. May be relative (resolved against the
 * CWD where you run `jobfinder`) or absolute. Default: `'data'` (the
 * repo-local folder).
 */
export const DATA_DIR = './data.local';

/**
 * File name of the SQLite database. This is a bare file name, not a path:
 * the database always lives at `DATA_DIR/DB_NAME`, so it cannot escape the
 * data directory. Default: `'jobs.db'`.
 */
export const DB_NAME = 'jobs.db';

/**
 * Each `LLM_*_MODEL` is an array of model IDs in fallback order. `llmSend`
 * always tries index 0 first and only advances to index 1 (then 2, ...)
 * after the current model has failed
 * `AUTO_CHOOSE_NEXT_MODEL_AFTER_N_ATTEMPTS` times in a row. When every
 * model in the array is exhausted, `llmSend` throws.
 *
 * Notes on the Claude Code CLI plugin:
 * - `claudecode-plugin/<model>` shells out to `claude -p` (see
 *   `src/llm/plugins/claudeCodeCli.ts`). The dispatcher in `src/llm/base.ts`
 *   strips the `claudecode-plugin/` prefix before calling the plugin, so the
 *   `<model>` half is a bare model id such as `claude-opus-4-8`.
 * - A stage's `reasoningEffort` maps onto the CLI's `--effort` flag
 *   (minimal→low, low, medium, high, xhigh).
 * - There is NO schema-enforced JSON: the CLI has no `output_config.format`
 *   equivalent, so structured output is prompt-driven (the harness injects
 *   the schema into the system prompt and retries on a parse/validation
 *   failure). Keep a fallback model in arrays where the stage returns JSON.
 * - Every call carries Claude Code's own system prompt + tool definitions
 *   (tens of thousands of cached tokens), inflating latency and
 *   subscription-quota usage relative to a lean API request.
 * - `enableWebSearch` is NOT supported (all tools are disabled for
 *   deterministic output); the plugin throws. The sourcing stage needs it,
 *   so `LLM_SOURCING_MODEL` below uses OpenRouter instead.
 */

/**
 * The model used by the seeding process.
 */
export const LLM_SEEDING_MODEL = ['claudecode-plugin/claude-haiku-4-5'];

/**
 * The model used by the sourcing process.
 *
 * Model requirements:
 * - web-search capability
 * - low input cost
 * - moderate output cost
 *
 * The Claude Code CLI plugin throws on `enableWebSearch`, so this stage MUST
 * use a web-search-capable plugin. OpenRouter is used here; swap in Ollama or
 * another provider if you prefer.
 */
export const LLM_SOURCING_MODEL = ['openrouter-plugin/openai/gpt-5-nano'];

/**
 * The model used by the listing process, asked to identify career pages on
 * companies websites.
 *
 * Model requirements:
 * - reasoning capability
 * - >=200K context window
 * - low input cost
 * - output cost doesn't matter much
 */
export const LLM_LISTING_MODEL = [
  'claudecode-plugin/claude-sonnet-5',
  'claudecode-plugin/claude-haiku-4-5',
];

/**
 * The model used by the coding process (writing custom parser scripts for
 * sources). This should be a code-specialized model.
 *
 * Model requirements:
 * - >=200K context window
 * - strong coding capability
 */
export const LLM_CODING_MODEL = [
  'claudecode-plugin/claude-opus-4-8',
  'claudecode-plugin/claude-sonnet-5',
];

/**
 * The model used by the viewing process for extracting and cleaning text from
 * HTML.
 *
 * Model requirements:
 * - >=200K context window
 * - low input cost
 * - low output cost
 */
export const LLM_VIEWING_MODEL = ['claudecode-plugin/claude-haiku-4-5'];

/**
 * The model used by the evaluate process, asked to compare your skill set and
 * the job requirements, and assign a score to how well you match the job.
 *
 * Model requirements:
 * - strong reasoning capability
 * - >=200K context window
 * - low input cost
 */
export const LLM_EVALUATION_MODEL = [
  'claudecode-plugin/claude-opus-4-8',
  'claudecode-plugin/claude-sonnet-5',
];

/**
 * The model used to fill the CV template (`<DATA_DIR>/cv-template.html`)
 * for a given job posting. Asked to rewrite the summary, build the
 * competency grid, reorder bullets, and inject keywords ethically from the
 * job's skillRequirements + full JD into the user's cv.md.
 *
 * Model requirements:
 * - reasoning capability (it's selecting + reordering content)
 * - >=200K context window (template + cv + JD all fit)
 * - moderate output cost (the whole filled HTML comes back)
 */
export const LLM_CV_TEMPLATE_MODEL = [
  'claudecode-plugin/claude-opus-4-8',
  'claudecode-plugin/claude-sonnet-5',
];

/**
 * Directory where tailored resume PDFs (generated via the TUI's `p` shortcut
 * on the job-detail screen) are written. Created on demand. May be relative
 * (resolved against the CWD where you run `jobfinder`) or absolute. Default:
 * `'./resumes'`.
 */
export const RESUME_OUTPUT_DIR = './resumes.out';

/**
 * Whether to use a headless browser when scraping websites.
 */
export const USE_HEADLESS_BROWSER = true;

/**
 * The maximum number of browser tabs to have open concurrently when scraping
 * websites. Set this to a larger number to speed up scraping, at the cost of
 * higher CPU and memory.
 */
export const MAX_CONCURRENT_BROWSER_TABS = 10;

/**
 * The maximum time to wait for a page to load in the browser when scraping
 * websites before considering the page is loaded enough to scrape data from it,
 * in milliseconds. Set this to a larger number if your internet is slow.
 */
export const BROWSER_NAVIGATION_TIMEOUT_MS = 10_000;

/**
 * The minimum time to wait after a page load before scraping data from it, in
 * milliseconds. This is to give the page some time to render its content after
 * the initial load event, which can help with sites that load content
 * dynamically with JavaScript. Set this to a larger number if you find that the
 * scraper is missing content that appears shortly after page load.
 */
export const BROWSER_NAVIGATION_MIN_WAIT_MS = 5_000;

/**
 * After sourcing, companies less than this interest score are tossed out to
 * reduce spam.
 */
export const PIPELINE_LISTING_MIN_INTEREST_SCORE = 0.5;

/**
 * When crawling a source's website to find job-listing pages, the maximum depth
 * of links to follow from the source URL. Depth 0 means only the source URL,
 * depth 1 means the source URL and all pages linked directly from it, etc.
 */
export const PIPELINE_LISTING_BFS_MAX_DEPTH = 3;

/**
 * When crawling a source's website to find job-listing pages, the maximum
 * number of pages to visit in total before giving up, across all depths. This
 * is to prevent the crawler from visiting an unbounded number of pages on large
 * websites with many same-domain links.
 */
export const PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE = 25;

/**
 * Toss out any job post whose title relevancy score is below this threshold
 * without even showing it to the user, to avoid overwhelming them with junk.
 *
 * The relavency score is a number between 0 and 1 that the viewing LLM assigns
 * to each job post based on how well the job post title matches the interest.md
 * file..
 */
export const PIPELINE_VIEWING_MIN_TITLE_RELEVANCY = 0.5;

/**
 * Posts whose viewing-stage locationScore falls below this threshold are
 * treated as out-of-scope by downstream stages (notably `evaluate`). The
 * viewing LLM produces a score in [0, 1] based on the posting's location +
 * remote status against the location preferences in interests.md.
 */
export const PIPELINE_VIEWING_MIN_LOCATION_RELEVANCY = 0.5;

/**
 * If a single job listing page shows more jobs than this amount, ask the LLM to
 * restrict the filters to narrow it down, to avoid overwhelming the user with
 * too many listings at once.
 */
export const PIPELINE_RUN_SCRIPTS_SPAM_PREVENTION_JOB_COUNTS = 50;

/**
 * User-defined color tags for JobPosts, surfaced as colored dots in the TUI.
 *
 * Keys are stored verbatim in `JobPost.tags` (JSON array, sorted
 * alphabetically by key). Values are the display labels shown in the
 * tag-picker menu. The first letter of each key becomes its keyboard
 * shortcut after pressing `t` (e.g. `t+r` toggles "red"), so keep the
 * first letters unique.
 */
export const TAGS = {
  red: 'Red',
  yellow: 'Yellow',
  blue: 'Blue',
  green: 'Green',
  purple: 'Purple',
};
