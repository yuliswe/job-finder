// This file is intentionally plain JavaScript so users can edit it without
// running a build. It is symlinked into `dist/` by `npm run build:assets`,
// so changes here take effect on the very next CLI run.
//
// Do NOT add imports that depend on the build-time module-resolver alias
// (e.g. `'src/foo.js'`) — at runtime this file lives at the repo root and
// Node ESM has no such alias. Keep this file to plain literals + env reads.

/**
 * The OpenRouter API key to use for the LLM calls. If not set, will fall back
 * to env var.
 */
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

/**
 * The Anthropic API key to use for the LLM calls. If not set, will fall back
 * to env var.
 */
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Serper API key (https://serper.dev). Used by `webSearchBySerper` to fetch
 * Google search results as structured JSON without driving a browser tab.
 */
export const SERPER_API_KEY = process.env.SERPER_API_KEY;

/**
 * Which LLM provider every `LLM_*_MODEL` model name is sent to.
 *   - `'openrouter'`  → OpenRouter API (default; supports the full model
 *                       catalogue + web-search). Requires OPENROUTER_API_KEY.
 *   - `'anthropic'`   → Anthropic SDK direct. Requires ANTHROPIC_API_KEY.
 *                       Note: enableWebSearch is not yet wired up.
 *   - `'ollama'`      → Local Ollama daemon. Requires Ollama installed and
 *                       the chosen model pulled (`ollama pull <tag>`). The
 *                       `LLM_*_MODEL` values become bare Ollama tags
 *                       (e.g. `'llama3.1'`, `'qwen2.5:14b'`).
 *
 * This is a global switch — all pipeline tasks use the same provider.
 */
export const LLM_PLUGIN = 'openrouter';

/**
 * Base URL of the local Ollama daemon, consulted when `LLM_PLUGIN ===
 * 'ollama'`. Default: `'http://localhost:11434'` (Ollama's default port).
 * Override via `OLLAMA_HOST` env var to point at a remote daemon.
 */
export const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

/**
 * Cap on simultaneous in-flight LLM requests across the whole process.
 * Wraps `plugin.send()` in a pLimit so the run-pipeline orchestrator
 * (6 task loops × per-task concurrency) doesn't fan out to the LLM
 * provider unboundedly.
 *
 * `undefined` (default for `openrouter` / `anthropic`) = unlimited; the
 *  provider's own rate limits are the only cap.
 *
 * When `LLM_PLUGIN === 'ollama'` and this value is not explicitly set,
 * the effective cap is forced to **1** — a local Ollama daemon
 * serializes inference internally and parallel requests just thrash GPU
 * memory. Set this explicitly to override that default (e.g. set to 2 if
 * you have enough VRAM for two simultaneous loads).
 */
export const LLM_REQUEST_CONCURRENCY_MAX = undefined;

/**
 * Directory holding the user's seed inputs — `interests.md`, `cv.md`, and
 * their gitignored `*.local.md` overrides. May be relative (resolved against
 * the CWD where you run `jobfinder`) or absolute. Default: `'seeds'` (the
 * repo-local folder).
 */
export const SEEDS_DIR = './seeds.local';

/**
 * Path to the SQLite database file. May be relative (to the CWD where you
 * run `jobfinder`) or absolute. Overridden by the `DB_PATH` env var (e.g.
 * via `.env.local`). Default: `'jobs.db'` (the repo-local file).
 */
export const DB_PATH = './jobs.db';

/**
 * The model used by the seeding process.
 */
export const LLM_SEEDING_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the sourcing process.
 *
 * Model requirements:
 * - web-search capability
 * - low input cost
 * - moderate output cost
 *
 * The model is asked to find a company URL from name, write a summary of the
 * company, and assign an interest score to the company based on the interest.md
 * file.
 */
export const LLM_SOURCING_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the listing process, asked to identify career pages on
 * companies websites.
 *
 * Model requirements:
 * - reasoning capability
 * - >=200K context window
 * - low input cost
 * - output cost doesn't matter much
 *
 */
export const LLM_LISTING_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the coding process (writing custom parser scripts for
 * sources). This should be a code-specialized model.
 *
 * Model requirements:
 * - >=200K context window
 * - strong coding capability (>=45 on OpenRouter's Code LLM Leaderboard)
 */
export const LLM_CODING_MODEL_CHEAPER = 'openai/gpt-5-nano';
export const LLM_CODING_MODEL_SMARTER = 'openai/gpt-5-mini';

/**
 * The model used by the viewing process for extracting and cleaning text from
 * HTML.
 *
 * Model requirements:
 * - >=200K context window
 * - low input cost
 * - low output cost
 */
export const LLM_VIEWING_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the evaluate process, asked to compare your skill set and
 * the job requirements, and assign a score to how well you match the job.
 *
 * Model requirements:
 * - strong reasoning capability
 * - >=200K context window
 * - low input cost
 * - low input cost
 */
export const LLM_EVALUATION_MODEL = 'openai/gpt-5-nano';

/**
 * The model used to fill the CV template (`<SEEDS_DIR>/cv-template.html`)
 * for a given job posting. Asked to rewrite the summary, build the
 * competency grid, reorder bullets, and inject keywords ethically from the
 * job's skillRequirements + full JD into the user's cv.md.
 *
 * Model requirements:
 * - reasoning capability (it's selecting + reordering content)
 * - >=200K context window (template + cv + JD all fit)
 * - moderate output cost (the whole filled HTML comes back)
 */
export const LLM_CV_TEMPLATE_MODEL = 'openai/gpt-5-nano';

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
 *
 * Defaults cover the five Ink-friendly colors. Add / remove freely — keys
 * that no longer exist in this map render as a fallback white dot when
 * surfaced from existing rows.
 */
export const TAGS = {
  red: 'Red',
  yellow: 'Yellow',
  blue: 'Blue',
  green: 'Green',
  purple: 'Purple',
};
