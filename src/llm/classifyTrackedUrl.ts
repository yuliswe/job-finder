import { type BrowserContext } from 'patchright';
import * as v from 'valibot';

import { LLM_VIEWING_MODEL } from 'src/utils/config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { goToPage, withBrowserTab } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal.js';

export type TrackedUrlPageType = 'job_post' | 'job_list' | 'none';

export type TrackedUrlClassification = {
  pageType: TrackedUrlPageType;
  /** Hiring company name as the page states it. Required when pageType is
   * 'job_post' or 'job_list'; null when 'none'. */
  companyName: string | null;
  reason: string;
};

const SYSTEM_PROMPT = `You classify a single web page by what it actually shows.

You will receive the URL, the page title, and the page's visible text (\`document.body.innerText\`).

Pick exactly one pageType:
- "job_post": the page is a single hiring posting — one role, one description, with responsibilities / requirements / how to apply for that one role.
- "job_list": the page enumerates multiple open roles — a careers / jobs index, a department listing, search results on a careers site. The page itself is not the description of any one role.
- "none": anything else (marketing page, blog post, login wall, 404, expired listing with no enumerable content, etc.).

Also extract the hiring company name (the organization that would employ the candidate). Trim suffixes like "Careers" or "is hiring". Return null for companyName only when pageType is "none" or when the page genuinely does not state any company.

Be conservative: when in doubt between "job_list" and "none", prefer "none". A page that is *about* careers but lists no concrete roles is "none", not "job_list".`;

/** Load `url`, ask the LLM to classify it as a single job post, a job-list
 * page, or neither, and extract the hiring company name. Returns null if the
 * page fails to load or the LLM call fails terminally. */
export async function classifyTrackedUrl(args: {
  context: BrowserContext;
  url: string;
}): Promise<TrackedUrlClassification | null> {
  const { context, url } = args;

  return withBrowserTab(context, async page => {
    let title: string;
    let text: string;
    try {
      await goToPage(page, url);
      title = await page.title();
      text = await page.evaluate(() => document.body.innerText);
    } catch (err) {
      terminal.error(`Failed to load ${url}: ${String(err)}`);
      return null;
    }

    try {
      const { result } = await feedbackLoop({
        memory: new Memory([{ system: SYSTEM_PROMPT }]),
        initialPrompt: `Page URL: ${url}
Page title: ${title}

Page text:
${text}

Classify the page and extract the hiring company name.`,
        schema: v.object({
          pageType: v.pipe(
            v.picklist(['job_post', 'job_list', 'none']),
            v.description(
              '"job_post" for a single hiring posting, "job_list" for a careers / jobs index, "none" for anything else.'
            )
          ),
          companyName: v.pipe(
            v.nullable(v.string()),
            v.description(
              'Hiring company name, trimmed (strip "Careers", "is hiring" suffixes). Required for job_post / job_list; null when pageType is "none" or the page does not state one.'
            )
          ),
          reason: v.pipe(
            v.string(),
            v.description(
              'One short sentence citing the concrete page evidence behind your pageType choice.'
            )
          ),
        }),
        maxAttempts: 3,
        models: LLM_VIEWING_MODEL,
        metadata: { configKey: 'LLM_VIEWING_MODEL' },
        logger: terminal,
        validate: parsed => {
          if (parsed.pageType !== 'none' && !parsed.companyName?.trim()) {
            return {
              valid: false,
              feedback: `pageType="${parsed.pageType}" requires a non-empty companyName. Re-read the page (header, footer, og:site_name, page title) and provide one, or set pageType to "none" if no hiring company is identifiable.`,
            };
          }

          return { valid: true, result: parsed };
        },
      });

      return {
        pageType: result.pageType,
        companyName: result.companyName?.trim() ?? null,
        reason: result.reason,
      };
    } catch (err) {
      terminal.error(
        `classifyTrackedUrl LLM call failed for ${url}: ${String(err)}`
      );
      return null;
    }
  });
}
