import { OpenRouterPlugin } from 'src/llm/plugins/openRouter.js';

export const plugin = new OpenRouterPlugin();

/**
 * The model used by the seeding process.
 */
export const LLM_SEEDING_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the sourcing process (job-source discovery from page HTML).
 */
export const LLM_SOURCING_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the listing process (job-list-source discovery + parser-script generation).
 */
export const LLM_LISTING_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the viewing process (parsing individual job-post pages).
 */
export const LLM_VIEWING_MODEL = 'openai/gpt-5-nano';

/**
 * The model used by the evaluate process (interest + skill scoring per job).
 */
export const LLM_EVALUATION_MODEL = 'openai/gpt-5-nano';

export const LLM_CODING_MODEL = 'deepseek/deepseek-v4-flash';
// export const LLM_CODING_MODEL = 'qwen/qwen3-coder-next';

export const OPENROUTER_API_KEY = '';

export const USE_HEADLESS_BROWSER = false;
export const MAX_CONCURRENT_BROWSER_TABS = 10;
export const BROWSER_NAVIGATION_TIMEOUT_MS = 5_000;

export const PIPELINE_LISTING_BFS_MAX_DEPTH = 3;
export const PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE = 50;
