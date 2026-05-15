import { type BrowserContext } from 'patchright';
import * as v from 'valibot';

import {
  BROWSER_NAVIGATION_TIMEOUT_MS,
  LLM_LISTING_MODEL,
  PIPELINE_LISTING_BFS_MAX_DEPTH,
  PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE,
} from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { withBrowserTab } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal';

const MAX_CRAWL_DECISION_ATTEMPTS = 3;

/**
 * Starting from `startUrl`, BFS the same-domain links the LLM ranks as most
 * likely to lead to a job-listing page (depth root = 0, capped at
 * `PIPELINE_LISTING_BFS_MAX_DEPTH` and at most
 * `PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE` pages visited overall). Returns
 * the URL of the first page the LLM classifies as a listing page, or null.
 */
export async function findJobListPage(args: {
  context: BrowserContext;
  startUrl: string;
}): Promise<string | null> {
  const { context, startUrl } = args;

  const visited = new Set<string>();
  const queue: { url: string; depth: number }[] = [];

  const normalizedStart = normalizeUrl(startUrl);
  if (!normalizedStart) {
    terminal.warn(`Invalid start URL: ${startUrl}`);
    return null;
  }
  queue.push({ url: normalizedStart, depth: 0 });

  while (queue.length > 0) {
    if (visited.size >= PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE) {
      terminal.warn(
        `BFS node budget exhausted (${PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE} pages visited) for ${normalizedStart} — giving up`
      );
      break;
    }

    const { url, depth } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    terminal.log(
      `[listing BFS depth=${depth} visited=${visited.size}/${PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE}] ${url}`
    );

    let page: PageSnapshot;
    try {
      page = await loadPage(context, url);
    } catch (err) {
      terminal.warn(`Failed to load ${url}: ${String(err)}`);
      continue;
    }

    let decision: v.InferOutput<typeof CrawlDecisionSchema>;
    try {
      decision = await classifyAndRankLinks({ url, page });
    } catch (err) {
      terminal.error(`LLM crawl-decision failed for ${url}: ${String(err)}`);
      continue;
    }

    if (decision.isJobListingPage) {
      terminal.log(`Found listing page: ${url} — ${decision.reason}`);
      return url;
    }

    if (depth < PIPELINE_LISTING_BFS_MAX_DEPTH) {
      for (const raw of decision.candidateLinks) {
        const norm = normalizeUrl(raw);
        if (!norm) continue;
        if (visited.has(norm)) continue;
        queue.push({ url: norm, depth: depth + 1 });
      }
    }
  }

  return null;
}

const CrawlDecisionSchema = v.object({
  isJobListingPage: v.boolean(),
  jobPostUrls: v.array(v.object({ url: v.string(), title: v.string() })),
  candidateLinks: v.array(v.string()),
  reason: v.string(),
});

/**
 * Ask the LLM to classify `page` as a job-listing page and rank its outgoing
 * links by likelihood of leading to one. Wrapped in a feedback loop that asks
 * the LLM to retry if it returns no signal (not-a-listing-page AND empty
 * candidate list — a dead end for BFS) or links not in the page's link set.
 */
async function classifyAndRankLinks(args: {
  url: string;
  page: PageSnapshot;
}): Promise<v.InferOutput<typeof CrawlDecisionSchema>> {
  const { url, page } = args;
  const linksOnPageSet = new Set(page.links);

  const memory = new Memory([
    {
      system: `You analyze pages on a company website to find their job-listing page.
Return:
- "isJobListingPage": true if this page lists current job openings. Usually it should have the UI for searching / filtering jobs by location, title, departments, etc. It must contain some job listings not just a button linking to the listing page, like "View Jobs" or "See Open Positions".
- "jobPostUrls": if "isJobListingPage" is true, return a list of URLs to job posts. Must not be empty if "isJobListingPage" is true.
- "candidateLinks": All URLs FROM THE LINKS LIST that are most likely to lead to the company's careers/jobs/openings page. IMPORTANT: Place the most likely ones first.
- "reason": one-line explanation.`,
    },
  ]);

  const { result } = await feedbackLoop<
    typeof CrawlDecisionSchema,
    v.InferOutput<typeof CrawlDecisionSchema>
  >({
    memory,
    initialPrompt: `URL: ${url}
Page title: ${page.title}

Page text:
${page.text}

Links on page:
${page.links.join('\n')}`,
    schema: CrawlDecisionSchema,
    maxAttempts: MAX_CRAWL_DECISION_ATTEMPTS,
    model: LLM_LISTING_MODEL,
    logger: terminal,
    validate: parsed => {
      if (!parsed.isJobListingPage && parsed.candidateLinks.length === 0) {
        return {
          valid: false,
          feedback:
            'You said this is NOT a job-listing page AND returned no candidateLinks. That leaves the search with no next step. Either (a) pick the most plausible links from the provided links list, or (b) reconsider whether this page actually is a listing page.',
        };
      }
      const hallucinated = parsed.candidateLinks.filter(
        l => !linksOnPageSet.has(l)
      );
      if (hallucinated.length > 0) {
        return {
          valid: false,
          feedback: `candidateLinks must be copied verbatim FROM THE LINKS LIST. These ${hallucinated.length} are not in the list and look invented: ${JSON.stringify(hallucinated.slice(0, 5))}. Pick only URLs that appear in the provided list.`,
        };
      }
      return { valid: true, result: parsed };
    },
  });

  return result;
}

type PageSnapshot = {
  title: string;
  text: string;
  links: string[];
};

async function loadPage(
  context: BrowserContext,
  url: string
): Promise<PageSnapshot> {
  return withBrowserTab(context, async page => {
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
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText);
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map(a => (a as HTMLAnchorElement).href)
        .filter(h => /^https?:\/\//i.test(h))
        .slice(0, 300);
    });
    return { title, text, links };
  });
}

function normalizeUrl(raw: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const u = new URL(withScheme);
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}
