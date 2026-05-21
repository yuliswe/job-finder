import { type BrowserContext } from 'patchright';
import * as v from 'valibot';

import { LLM_SOURCING_MODEL } from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { DISCOVER_JOB_SOURCE_SYSTEM_PROMPT } from 'src/prompts/discoverJobSource.js';
import { goToPage, withBrowserTab } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal';

const MAX_DISCOVER_ATTEMPTS = 3;

export type JobSource = {
  name: string;
  /** Hostname only, e.g. "acme.com". */
  url: string;
};

/** Open the URL in a tab of the given browser context, ask the LLM to identify the hiring company. */
export async function discoverJobSource(args: {
  context: BrowserContext;
  url: string;
}): Promise<JobSource | null> {
  const { context, url } = args;

  terminal.log(`Opening in browser: ${url}`);
  const { pageText, pageTitle } = await withBrowserTab(context, async page => {
    await goToPage(page, url);
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText);
    return { pageText: text, pageTitle: title };
  });

  terminal.log(
    `Page title: ${pageTitle} | Page text length: ${pageText.length}`
  );

  const memory = new Memory([{ system: DISCOVER_JOB_SOURCE_SYSTEM_PROMPT }]);
  let lastReason = '';

  try {
    const { result } = await feedbackLoop({
      memory,
      initialPrompt: `Job posting URL: ${url}
Page title: ${pageTitle}

Page body:
${pageText}`,
      schema: v.object({
        name: v.pipe(
          v.string(),
          v.description(
            'Display name of the hiring company (e.g. "Acme Corp"). Empty string if you can\'t tell from the page.'
          )
        ),
        url: v.pipe(
          v.string(),
          v.description(
            'Primary corporate website URL of the hiring company (e.g. "https://acme.com"). Prefer the company\'s own site over the job-board host. Empty string if you can\'t find one on the page.'
          )
        ),
        reason: v.pipe(
          v.string(),
          v.description(
            'If you returned an empty name or url, explain why; otherwise an empty string.'
          )
        ),
      }),
      maxAttempts: MAX_DISCOVER_ATTEMPTS,
      model: LLM_SOURCING_MODEL,
      metadata: { configKey: 'LLM_SOURCING_MODEL' },
      logger: terminal,
      // The LLM has the provider's native web_search tool available. Per the
      // system prompt, it should call web_search itself when the page text
      // doesn't reveal the company URL — no out-of-band Google scrape
      // needed any more.
      enableWebSearch: true,
      validate: async parsed => {
        const name = parsed.name.trim();
        const rawUrl = parsed.url.trim();

        if (!name) {
          lastReason = parsed.reason.trim() || '(no reason given)';
          return {
            valid: false,
            feedback: `You did not identify a company name (name="${parsed.name}", reason="${parsed.reason}"). Search the web for the company by job-board posting URL if needed, or re-examine the page text — look for the employer name in the job header, the "About" section, or footer credits.`,
          };
        }

        if (rawUrl) {
          const hostname = toHostname(rawUrl);
          if (hostname) return { valid: true, result: { name, url: hostname } };

          return {
            valid: false,
            feedback: `You returned url="${rawUrl}" but it doesn't parse as a hostname. Return a clean URL like "https://acme.com" — or call web_search for the company's official site again and pick a parseable result.`,
          };
        }

        lastReason =
          parsed.reason.trim() ||
          'Page did not name a usable URL and the LLM web search found nothing.';
        return {
          valid: false,
          feedback: `You returned name="${name}" but no url. Call web_search with a query like \`"${name}" official company website\` and pick the company's own primary domain. If web_search has already turned up nothing, return an empty url and explain why in "reason".`,
        };
      },
    });

    terminal.log(`Identified hiring company "${result.name}" (${result.url})`);
    return result;
  } catch {
    terminal.warn(
      `Could not identify hiring company for ${url}: ${lastReason}`
    );
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
