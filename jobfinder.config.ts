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

export const OPENROUTER_API_KEY = '';

export const USE_HEADLESS_BROWSER = false;
export const MAX_CONCURRENT_BROWSER_TABS = 5;
export const BROWSER_NAVIGATION_TIMEOUT_MS = 15_000;
