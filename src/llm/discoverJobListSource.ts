import { type BrowserContext } from 'patchright';
import * as v from 'valibot';

import {
  LLM_LISTING_MODEL,
  PIPELINE_LISTING_BFS_MAX_DEPTH,
  PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE,
} from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { CLASSIFY_AND_RANK_LINKS_SYSTEM_PROMPT } from 'src/prompts/classifyAndRankLinks.js';
import { VERIFY_IS_JOB_POST_SYSTEM_PROMPT } from 'src/prompts/verifyIsJobPost.js';
import { goToPage, withBrowserTab } from 'src/utils/browser.js';
import { terminal } from 'src/utils/terminal';

const MAX_CRAWL_DECISION_ATTEMPTS = 3;

export type FindJobListPageResult =
  | { kind: 'found'; url: string }
  | { kind: 'not_found' }
  | { kind: 'aborted'; reason: string };

/**
 * Starting from `startUrl`, BFS the same-domain links the LLM ranks as most
 * likely to lead to a job-listing page (depth root = 0, capped at
 * `PIPELINE_LISTING_BFS_MAX_DEPTH` and at most
 * `PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE` pages visited overall).
 *
 * Returns:
 *   - `{ kind: 'found', url }`         — first page the LLM classified AND
 *                                        verified as a listing page.
 *   - `{ kind: 'aborted', reason }`    — LLM signalled `abortSearch=true`
 *                                        with a high-confidence verdict that
 *                                        this source has no listings to find.
 *                                        Caller should persist the reason.
 *   - `{ kind: 'not_found' }`          — exhausted depth / node budget or
 *                                        ran out of links without success.
 */
export async function findJobListPage(args: {
  context: BrowserContext;
  startUrl: string;
}): Promise<FindJobListPageResult> {
  const { context, startUrl } = args;

  const visited = new Set<string>();
  // Best-first priority queue: sort descending by `score` on every insert
  // so `shift()` always returns the currently-most-promising URL.
  // Cross-page comparison: a high-scoring child of an earlier page wins
  // over a low-scoring child of a later page. Sort-on-insert is O(n log n)
  // per insert, but n is bounded by PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE
  // (50 by default), so a heap library would be over-engineering.
  const queue: { url: string; depth: number; score: number }[] = [];

  const normalizedStart = normalizeUrl(startUrl);
  if (!normalizedStart) {
    terminal.warn(`Invalid start URL: ${startUrl}`);
    return { kind: 'not_found' };
  }

  // Root is unscored — it's the source the user gave us. Use 1.0 so it's
  // always processed first (queue is empty anyway, but this stays
  // consistent if the caller ever pre-seeds extra URLs).
  queue.push({ url: normalizedStart, depth: 0, score: 1 });

  while (queue.length > 0) {
    if (visited.size >= PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE) {
      terminal.warn(
        `Priority-queue node budget exhausted (${PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE} pages visited) for ${normalizedStart} — giving up`
      );
      break;
    }

    const { url, depth, score } = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    terminal.log(
      `[listing PQ depth=${depth} score=${score.toFixed(2)} visited=${visited.size}/${PIPELINE_LISTING_BFS_MAX_NODES_PER_SOURCE}] ${url}`
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

    if (decision.abortSearch) {
      // `abortReason` is LLM-generated and validated non-empty above.
      terminal.warn(
        `BFS aborted by LLM at ${url} after ${visited.size} page(s): ${decision.abortReason}`
      );
      return { kind: 'aborted', reason: decision.abortReason };
    }

    if (decision.isJobListingPage) {
      // Sanity-check: open the first job post URL the LLM extracted and ask
      // the LLM to confirm it actually looks like a job posting. Catches
      // false positives where the LLM mislabels a careers/landing page as a
      // listing.
      const sampleUrl = decision.jobPostUrls[0]?.url;
      if (!sampleUrl) {
        terminal.warn(
          `Listing claim for ${url} rejected — LLM returned no jobPostUrls to validate against.`
        );
      } else {
        try {
          const verdict = await verifyIsJobPost({ context, url: sampleUrl });
          if (verdict.isJobPost) {
            terminal.log(
              `Found listing page: ${url} — ${decision.reason} (sample ${sampleUrl}: ${verdict.reason})`
            );
            return { kind: 'found', url };
          }

          terminal.warn(
            `Listing claim for ${url} rejected — sample ${sampleUrl} is not a job posting: ${verdict.reason}`
          );
        } catch (err) {
          terminal.warn(
            `Listing claim for ${url} unverified — verifyIsJobPost failed for ${sampleUrl}: ${String(err)}`
          );
        }
      }
    }

    if (depth < PIPELINE_LISTING_BFS_MAX_DEPTH) {
      let enqueued = 0;
      for (const candidate of decision.candidateLinks) {
        const norm = normalizeUrl(candidate.url);
        if (!norm) continue;
        if (visited.has(norm)) continue;

        queue.push({
          url: norm,
          depth: depth + 1,
          score: candidate.score,
        });

        enqueued++;
      }

      // Re-sort the whole queue: a high-scoring new entry must jump ahead
      // of stale lower-scoring entries from earlier pages.
      if (enqueued > 0) queue.sort((a, b) => b.score - a.score);
    }
  }

  return { kind: 'not_found' };
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
  candidateLinks: { url: string; score: number }[];
  abortSearch: boolean;
  abortReason: string;
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
        v.array(
          v.object({
            url: v.pipe(
              v.string(),
              v.description('URL copied verbatim FROM THE LINKS LIST above.')
            ),
            score: v.pipe(
              v.number(),
              v.description(
                'Probability in [0, 1] that this URL is — or leads to — the listing page. The crawler pops the highest-scored URL across the entire search next, so use the full range honestly (see the system prompt for the scale).'
              )
            ),
          })
        ),
        v.description(
          'URLs copied verbatim FROM THE LINKS LIST above, each with a likelihood score. Order does not matter — the crawler sorts by score. Empty only if this page IS the listing page, you are aborting the search, or there are truly no plausible candidates.'
        )
      ),
      abortSearch: v.pipe(
        v.boolean(),
        v.description(
          'Set TRUE only if you have high confidence this company does NOT publish job listings reachable from anywhere within the same domain — e.g. the site is a personal blog, an inactive/parked domain, a non-hiring landing page with no careers section that links nowhere relevant, or a 404/error wall. When TRUE, the BFS abandons this source entirely. Do NOT set true just because THIS page is not a listing — only when you are sure the whole search is futile. False by default.'
        )
      ),
      abortReason: v.pipe(
        v.string(),
        v.description(
          'When abortSearch=true, one short sentence explaining what about the site makes the search futile (cited evidence from the page text + links). Empty string when abortSearch=false.'
        )
      ),
      reason: v.pipe(
        v.string(),
        v.description('One-line explanation of your classification.')
      ),
    }),
    maxAttempts: MAX_CRAWL_DECISION_ATTEMPTS,
    models: LLM_LISTING_MODEL,
    metadata: { configKey: 'LLM_LISTING_MODEL' },
    logger: terminal,
    validate: parsed => {
      if (
        !parsed.isJobListingPage &&
        !parsed.abortSearch &&
        parsed.candidateLinks.length === 0
      ) {
        return {
          valid: false,
          feedback:
            'You said this is NOT a job-listing page, did NOT abort the search, AND returned no candidateLinks. That leaves the search with no next step. Either (a) pick the most plausible links from the provided links list, (b) reconsider whether this page actually is a listing page, or (c) set abortSearch=true with an abortReason if you genuinely believe the whole site has no listings to find.',
        };
      }

      if (parsed.abortSearch && !parsed.abortReason.trim()) {
        return {
          valid: false,
          feedback:
            'abortSearch=true requires a non-empty abortReason citing the evidence (e.g. "site is a personal blog with no careers section and no outbound links to job platforms").',
        };
      }

      const hallucinated = parsed.candidateLinks
        .map(c => c.url)
        .filter(u => !linksOnPageSet.has(u));

      if (hallucinated.length > 0) {
        return {
          valid: false,
          feedback: `candidateLinks must be copied verbatim FROM THE LINKS LIST. These ${hallucinated.length} are not in the list and look invented: ${JSON.stringify(hallucinated.slice(0, 5))}. Pick only URLs that appear in the provided list.`,
        };
      }

      const outOfRange = parsed.candidateLinks.filter(
        c => !Number.isFinite(c.score) || c.score < 0 || c.score > 1
      );

      if (outOfRange.length > 0) {
        return {
          valid: false,
          feedback: `Every candidateLinks.score must be a finite number in [0, 1]. Out-of-range scores: ${JSON.stringify(outOfRange.slice(0, 5))}.`,
        };
      }

      return { valid: true, result: parsed };
    },
  });

  return result;
}

/** Open `url`, grab innerText, and ask the LLM whether the page looks like a
 * single job posting. Throws on load or LLM failure — the BFS loop catches
 * and treats the listing claim as unverified. */
async function verifyIsJobPost(args: {
  context: BrowserContext;
  url: string;
}): Promise<{ isJobPost: boolean; reason: string }> {
  const { context, url } = args;

  const { text } = await loadPage(context, url);

  const memory = new Memory([{ system: VERIFY_IS_JOB_POST_SYSTEM_PROMPT }]);
  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `URL: ${url}\n\nPage text:\n${text}`,
    schema: v.object({
      isJobPost: v.pipe(
        v.boolean(),
        v.description(
          'True if the page is a single job posting (title + role description and/or requirements). False for landing/listing pages, errors, login walls, etc.'
        )
      ),
      reason: v.pipe(
        v.string(),
        v.description('One short sentence explaining your call.')
      ),
    }),
    maxAttempts: 1,
    models: LLM_LISTING_MODEL,
    metadata: { configKey: 'LLM_LISTING_MODEL' },
    logger: terminal,
    validate: parsed => ({ valid: true, result: parsed }),
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
    await goToPage(page, url);
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
