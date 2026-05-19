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

export type SkillRequirement = {
  skill: string;
  importance: number;
  reason: string;
};

export type SkillRequirements = SkillRequirement[];

export type ViewedJobPost = {
  isJobPosting: boolean;
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
  skillRequirements: SkillRequirements;
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
          isJobPosting: v.pipe(
            v.boolean(),
            v.description(
              'true if this page is actually a single job posting whose content you can extract. false ONLY when the page is something else (error page, expired/removed listing, login wall, a listings/index page, completely empty content, etc.). When false, return null for every other field — we will record this URL as un-viewable and stop retrying it.'
            )
          ),
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
          skillRequirements: v.pipe(
            v.array(
              v.object({
                skill: v.pipe(
                  v.string(),
                  v.description(
                    'Short canonical name of a skill / qualification / requirement the posting itself asks for.'
                  )
                ),
                importance: v.pipe(
                  v.number(),
                  v.description(
                    'How load-bearing the posting makes this skill, in [0, 1]. 1.0 = must-have; 0.5 = nice-to-have; ~0.1 = mentioned in passing.'
                  )
                ),
                reason: v.pipe(
                  v.string(),
                  v.description(
                    'Natural-prose sentence (≤ ~300 chars), in your own words, paraphrasing what the posting demands and noting how strongly it is framed (hard requirement / nice-to-have / passing mention). Do NOT use quote marks or copy raw phrases from the posting. Do NOT add facts the posting does not state.'
                  )
                ),
              })
            ),
            v.description(
              'Per-skill list derived entirely from the posting. Cap at ~15 entries. Empty array if the page is not a posting.'
            )
          ),
        }),
        maxAttempts: 3,
        model: LLM_VIEWING_MODEL,
        metadata: { configKey: 'LLM_VIEWING_MODEL' },
        logger: terminal,
        validate: parsed => {
          // The LLM is telling us this URL isn't a job posting — accept and
          // stop retrying. The caller marks the trigger processed.
          if (!parsed.isJobPosting) return { valid: true, result: parsed };
          if (!parsed.description?.trim()) {
            return {
              valid: false,
              feedback:
                'You returned null/empty for `description` but `isJobPosting` is true. Either: (a) re-extract the description (look harder — responsibilities, requirements, about-the-role, what-you-will-do sections), or (b) if the page genuinely is not a job posting, set `isJobPosting` to false and null every other field.',
            };
          }

          return { valid: true, result: parsed };
        },
      });

      return result;
    } catch (err) {
      terminal.error(`viewJobPost LLM call failed for ${url}: ${String(err)}`);
      return null;
    }
  });
}
