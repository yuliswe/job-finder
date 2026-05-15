import { OpenRouterPlugin } from 'src/llm/plugins/openRouter.js';

export const plugin = new OpenRouterPlugin();

/**
 * The model used by the seeding process.
 */
export const LLM_SEEDING_MODEL = 'openai/gpt-5-nano';

export const OPENROUTER_API_KEY = '';
