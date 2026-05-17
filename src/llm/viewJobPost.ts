import { type BrowserContext } from 'patchright';
import * as v from 'valibot';

import {
  BROWSER_NAVIGATION_TIMEOUT_MS,
  LLM_VIEWING_MODEL,
} from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { VIEW_JOB_POST_SYSTEM_PROMPT } from 'src/prompts/viewJobPost.js';
import { withBrowserTab } from 'src/utils/browser.js';
import { cleanHtmlForLlm } from 'src/utils/html.js';
import { terminal } from 'src/utils/terminal';

export type ViewedJobPost = {
  title: string | null;
  company: string | null;
  description: string | null;
  isRemote: boolean | null;
  jobType: string | null;
  location: string | null;
  postedAt: string | null;
  salaryCurrency: string | null;
  salaryInterval: string | null;
  salaryMax: number | null;
  salaryMin: number | null;
  summary: string | null;
};

/**
 * Load `url`, hand the cleaned HTML to the LLM, and return the structured
 * fields parsed out of the job-posting page. Returns null if the page fails to
 * load or the LLM call fails terminally.
 */
export async function viewJobPost(args: {
  context: BrowserContext;
  url: string;
}): Promise<ViewedJobPost | null> {
  const { context, url } = args;

  return withBrowserTab(context, async page => {
    let title: string;
    let html: string;
    try {
      try {
        await page.goto(url, {
          waitUntil: 'networkidle',
          timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
        });
      } catch {
        terminal.warn(
          `Timeout/network error loading ${url}; proceeding with whatever content loaded`
        );
      }
      title = await page.title();
      html = await cleanHtmlForLlm(page);
    } catch (err) {
      terminal.error(`Failed to load ${url}: ${String(err)}`);
      return null;
    }

    try {
      const { result } = await feedbackLoop({
        memory: new Memory([{ system: VIEW_JOB_POST_SYSTEM_PROMPT }]),
        initialPrompt: `Posting URL: ${url}
Page title: ${title}

Page HTML:
${html}

Extract the fields. Return null for anything the page does not actually state.`,
        schema: v.object({
          title: v.pipe(
            v.nullable(v.string()),
            v.description(
              "Posting title (the page's main headline). null if unreadable."
            )
          ),
          company: v.pipe(
            v.nullable(v.string()),
            v.description(
              'Hiring company name, trimmed. null if not stated on the page.'
            )
          ),
          location: v.pipe(
            v.nullable(v.string()),
            v.description(
              'Primary work location string. Join multiple equally-weighted locations with "; ". null if not stated.'
            )
          ),
          isRemote: v.pipe(
            v.nullable(v.boolean()),
            v.description(
              'true ONLY if the page clearly says fully remote. false for onsite/hybrid. null if unclear.'
            )
          ),
          jobType: v.pipe(
            v.nullable(v.string()),
            v.description(
              'One of fulltime / parttime / contract / temporary / internship / perdiem / nights / summer / volunteer / other. null if unspecified.'
            )
          ),
          postedAt: v.pipe(
            v.nullable(v.string()),
            v.description(
              'ISO 8601 UTC timestamp of when the job was posted (e.g. "2026-05-10T00:00:00Z"). null if not visible.'
            )
          ),
          salaryCurrency: v.pipe(
            v.nullable(v.string()),
            v.description(
              '3-letter ISO 4217 currency code (USD / CAD / EUR / …). null if no salary is posted.'
            )
          ),
          salaryInterval: v.pipe(
            v.nullable(v.string()),
            v.description(
              'One of hour / day / week / month / year. null if no salary or interval is unclear.'
            )
          ),
          salaryMin: v.pipe(
            v.nullable(v.number()),
            v.description('Lower bound of posted salary. null if not posted.')
          ),
          salaryMax: v.pipe(
            v.nullable(v.number()),
            v.description(
              'Upper bound of posted salary. If only a single number is given, set both to the same value. null if not posted.'
            )
          ),
          description: v.pipe(
            v.nullable(v.string()),
            v.description(
              'Full job description plaintext (responsibilities + requirements + benefits). Truncate at ~8000 chars. null if no description visible.'
            )
          ),
          summary: v.pipe(
            v.nullable(v.string()),
            v.description(
              '1-2 sentence neutral summary of the role for a list view. null if there is not enough info.'
            )
          ),
        }),
        maxAttempts: 1,
        model: LLM_VIEWING_MODEL,
        logger: terminal,
        validate: parsed => ({ valid: true, result: parsed }),
      });
      return result;
    } catch (err) {
      terminal.error(`viewJobPost LLM call failed for ${url}: ${String(err)}`);
      return null;
    }
  });
}
