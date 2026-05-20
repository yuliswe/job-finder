import { OpenRouterPlugin } from 'src/llm/plugins/openRouter.js';

export const plugin = new OpenRouterPlugin();

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
 * The model used by the seeding process.
 */
export const LLM_SEEDING_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the sourcing process.
 */
export const LLM_SOURCING_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the listing process.
 */
export const LLM_LISTING_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the viewing process.
 */
export const LLM_VIEWING_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the evaluate process.
 */
export const LLM_EVALUATION_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the coding process (writing custom parser scripts for
 * sources). This should be a code-specialized model.
 */
export const LLM_CODING_MODEL_CHEAPER = 'deepseek/deepseek-v4-flash';
export const LLM_CODING_MODEL_SMARTER = 'xiaomi/mimo-v2.5-pro';

/**
 * Whether to use a headless browser when scraping websites.
 */
export const USE_HEADLESS_BROWSER = true;

/**
 * The maximum number of browser tabs to have open concurrently when scraping
 * websites. Set this to a larger number to speed up scraping, at the cost of
 * higher CPU and memory.
 */
export const MAX_CONCURRENT_BROWSER_TABS = 30;

/**
 * The maximum time to wait for a page to load in the browser when scraping
 * websites before considering the page is loaded enough to scrape data from it,
 * in milliseconds. Set this to a larger number if your internet is slow.
 */
export const BROWSER_NAVIGATION_TIMEOUT_MS = 10_000;

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
export const PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE = 50;

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
 * If a single job listing page shows more jobs than this amount, ask the LLM to
 * restrict the filters to narrow it down, to avoid overwhelming the user with
 * too many listings at once.
 */
export const PIPELINE_RUN_SCRIPTS_SPAM_PREVENTION_JOB_COUNTS = 50;
