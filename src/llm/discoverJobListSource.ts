import { type BrowserContext } from 'patchright';
import * as v from 'valibot';

import {
  BROWSER_NAVIGATION_TIMEOUT_MS,
  LLM_LISTING_MODEL,
  PIPELINE_LISTING_BFS_MAX_DEPTH,
  PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE,
} from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { CLASSIFY_AND_RANK_LINKS_SYSTEM_PROMPT } from 'src/prompts/classifyAndRankLinks.js';
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

    let decision: Awaited<ReturnType<typeof classifyAndRankLinks>>;
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

/**
 * Ask the LLM to classify `page` as a job-listing page and rank its outgoing
 * links by likelihood of leading to one. Wrapped in a feedback loop that asks
 * the LLM to retry if it returns no signal (not-a-listing-page AND empty
 * candidate list — a dead end for BFS) or links not in the page's link set.
 */
async function classifyAndRankLinks(args: {
  url: string;
  page: PageSnapshot;
}): Promise<{
  isJobListingPage: boolean;
  jobPostUrls: { url: string; title: string }[];
  candidateLinks: string[];
  reason: string;
}> {
  const { url, page } = args;
  const linksOnPageSet = new Set(page.links);

  const memory = new Memory([
    { system: CLASSIFY_AND_RANK_LINKS_SYSTEM_PROMPT },
  ]);

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `URL: ${url}
Page title: ${page.title}

Page text:
${page.text}

Links on page:
${page.links.join('\n')}`,
    schema: v.object({
      isJobListingPage: v.pipe(
        v.boolean(),
        v.description(
          'True if THIS page already lists current job openings (multiple postings visible with a job-search/filter UI). False for homepages, About pages, careers landing pages without postings, etc.'
        )
      ),
      jobPostUrls: v.pipe(
        v.array(
          v.object({
            url: v.pipe(
              v.string(),
              v.description('Absolute URL of one visible job post.')
            ),
            title: v.pipe(
              v.string(),
              v.description('Display title of that job post.')
            ),
          })
        ),
        v.description(
          'When isJobListingPage=true, every job posting visible on the page as { url, title }. Must be non-empty when isJobListingPage=true; ignored otherwise.'
        )
      ),
      candidateLinks: v.pipe(
        v.array(v.string()),
        v.description(
          'URLs copied verbatim FROM THE LINKS LIST above that are most likely to lead to the company careers/jobs page. Order them most-likely first. Empty only if this page IS the listing page or there are truly no plausible candidates.'
        )
      ),
      reason: v.pipe(
        v.string(),
        v.description('One-line explanation of your classification.')
      ),
    }),
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

    // Only read text/anchors from the main frame — if listings live in an
    // iframe (Ashby, Greenhouse, Lever, Workday…), we want BFS to navigate to
    // that ATS URL and classify it on its own, rather than the wrapper page
    // claiming credit for content it merely embeds.
    const main = page.mainFrame();
    const text = await main
      .evaluate(() => document.body.innerText)
      .catch(() => '');
    const mainLinks = await main
      .evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'))
          .map(a => (a as HTMLAnchorElement).href)
          .filter(h => /^https?:\/\//i.test(h))
      )
      .catch(() => [] as string[]);

    // Each iframe's src is a candidate next hop — that's where the embedded
    // listing actually lives.
    const iframeSrcs = page
      .frames()
      .filter(f => f !== main)
      .map(f => f.url())
      .filter(u => /^https?:\/\//i.test(u));

    const links = Array.from(new Set([...mainLinks, ...iframeSrcs])).slice(
      0,
      300
    );
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
