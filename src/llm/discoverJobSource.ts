import { type BrowserContext } from 'patchright';
import * as v from 'valibot';

import {
  BROWSER_NAVIGATION_TIMEOUT_MS,
  LLM_SOURCING_MODEL,
} from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { webSearch } from 'src/llm/webSearch.js';
import { withBrowserTab } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal';

const MAX_DISCOVER_ATTEMPTS = 3;
const MAX_WEB_SEARCH_ATTEMPTS = 2;

const DiscoverResultSchema = v.object({
  name: v.string(),
  url: v.string(),
  reason: v.string(),
});

const SYSTEM_PROMPT = `You read job-posting webpages and identify the hiring company.

Return:
- "name": the company's display name (e.g. "Acme Corp"). If you can't tell, return an empty string.
- "url": the company's primary website URL (e.g. "https://acme.com"). Prefer the company's own site over the job board hosting the post. If you can't tell, return an empty string.
- "reason": If you returned empty "name" or "url", explain why (e.g. "page only lists the job title, no employer named"). If both are filled in confidently, return an empty string.

According to the webpage, what is the company hiring and what is their URL?`;

const WebSearchResultSchema = v.object({
  url: v.string(),
  reason: v.string(),
});

const WEB_SEARCH_SYSTEM_PROMPT = `You read Google search result pages and find a company's primary website URL.

Return:
- "url": the company's primary corporate website (e.g. "https://acme.com"). Prefer the company's own homepage over Wikipedia, LinkedIn, Crunchbase, or job-board pages. If you can't find a confident match in the results, return an empty string.
- "reason": If "url" is empty, explain why; otherwise return an empty string.`;

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
    try {
      await page.goto(url, {
        waitUntil: 'networkidle',
        timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
      });
    } catch {
      terminal.warn(
        `Failed to load page ${url} within timeout, proceeding with whatever content loaded`
      );
    }
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText);
    return { pageText: text, pageTitle: title };
  });

  terminal.log(
    `Page title: ${pageTitle} | Page text length: ${pageText.length}`
  );

  const memory = new Memory([{ system: SYSTEM_PROMPT }]);
  let lastReason = '';

  try {
    const { result } = await feedbackLoop<
      typeof DiscoverResultSchema,
      JobSource
    >({
      memory,
      initialPrompt: `Job posting URL: ${url}
Page title: ${pageTitle}

Page body:
${pageText}`,
      schema: DiscoverResultSchema,
      maxAttempts: MAX_DISCOVER_ATTEMPTS,
      model: LLM_SOURCING_MODEL,
      logger: terminal,
      validate: async parsed => {
        const name = parsed.name.trim();
        const rawUrl = parsed.url.trim();

        if (!name) {
          lastReason = parsed.reason.trim() || '(no reason given)';
          return {
            valid: false,
            feedback: `You did not identify a company name (name="${parsed.name}", reason="${parsed.reason}"). Re-examine the page text — look for the employer name in the job header, the "About" section, or footer credits.`,
          };
        }

        // Try the URL the LLM extracted from the page first.
        if (rawUrl) {
          const hostname = toHostname(rawUrl);
          if (hostname) return { valid: true, result: { name, url: hostname } };
          terminal.warn(
            `LLM returned unparseable url "${rawUrl}" for "${name}" — falling back to web search`
          );
        } else {
          terminal.log(
            `LLM identified "${name}" but no URL on the page — falling back to web search`
          );
        }

        // Fall back: Google for the company's website.
        const hostname = await findCompanyWebsite({ context, name });
        if (hostname) return { valid: true, result: { name, url: hostname } };

        lastReason = `Page did not name a usable URL and web search for "${name}" found nothing.`;
        return {
          valid: false,
          feedback: `You returned name="${name}" but no usable url, and a web search for the company turned up nothing either. Re-examine the page text — look for any company-website link, contact page, or apply-on-company-site button.`,
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

/** Google the company name and have the LLM extract a corporate URL. */
async function findCompanyWebsite(args: {
  context: BrowserContext;
  name: string;
}): Promise<string | null> {
  const { context, name } = args;
  try {
    const result = await webSearch({
      context,
      query: `${name} official company website`,
      schema: WebSearchResultSchema,
      systemPrompt: WEB_SEARCH_SYSTEM_PROMPT,
      model: LLM_SOURCING_MODEL,
      maxAttempts: MAX_WEB_SEARCH_ATTEMPTS,
    });
    const raw = result.url.trim();
    if (!raw) return null;
    return toHostname(raw);
  } catch (err) {
    terminal.warn(`Web search for "${name}" failed: ${String(err)}`);
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
