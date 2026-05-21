import * as v from 'valibot';

import { LLM_SOURCING_MODEL } from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { FIND_COMPANY_URL_SYSTEM_PROMPT } from 'src/prompts/findCompanyUrl.js';
import { terminal } from 'src/utils/terminal.js';

const MAX_ATTEMPTS = 3;

/** Ask the LLM (with web search) for the primary corporate URL of a given
 * company name. Returns the hostname-only form (e.g. "acme.com") or null if
 * the LLM couldn't find a usable URL across `MAX_ATTEMPTS` tries. */
export async function findCompanyUrl(args: {
  name: string;
}): Promise<string | null> {
  const { name } = args;
  const memory = new Memory([{ system: FIND_COMPANY_URL_SYSTEM_PROMPT }]);
  let lastReason = '';

  try {
    const { result } = await feedbackLoop({
      memory,
      initialPrompt: `Company name: ${name}`,
      schema: v.object({
        url: v.pipe(
          v.string(),
          v.description(
            'Primary corporate website URL of the company (e.g. "https://acme.com"). Empty string ONLY when web_search has been tried and turned up nothing.'
          )
        ),
        reason: v.pipe(
          v.string(),
          v.description(
            'If you returned an empty url, explain why (including search queries tried); otherwise empty string.'
          )
        ),
      }),
      maxAttempts: MAX_ATTEMPTS,
      model: LLM_SOURCING_MODEL,
      metadata: { configKey: 'LLM_SOURCING_MODEL' },
      logger: terminal,
      enableWebSearch: true,
      validate: async parsed => {
        const rawUrl = parsed.url.trim();

        if (!rawUrl) {
          lastReason = parsed.reason.trim() || '(no reason given)';
          return {
            valid: false,
            feedback: `You returned no url for "${name}". Call web_search with a query like \`"${name}" official company website\` and pick the company's own primary domain. If web_search has already turned up nothing, return an empty url and explain why in "reason".`,
          };
        }

        const hostname = toHostname(rawUrl);
        if (hostname) return { valid: true, result: hostname };

        return {
          valid: false,
          feedback: `You returned url="${rawUrl}" but it doesn't parse as a hostname. Return a clean URL like "https://acme.com".`,
        };
      },
    });

    terminal.log(`Identified URL for "${name}": ${result}`);
    return result;
  } catch {
    terminal.warn(`Could not identify URL for "${name}": ${lastReason}`);
    return null;
  }
}

function toHostname(raw: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
}
