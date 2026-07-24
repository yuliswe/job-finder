import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';
import * as v from 'valibot';

import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import { PIPELINE_STATE, recordPipelineState } from 'src/db/pipelineState.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { DATA_DIR, LLM_SEEDING_MODEL } from 'jobfinder.config.js';
import {
  SEEDING_SUMMARY_SYSTEM_PROMPT,
  SEEDING_SYSTEM_PROMPT,
} from 'src/prompts/seeding.js';
import {
  JobspyError,
  scrapeJobs,
  type JobResult,
} from 'src/python-jobspy/index.js';
import { terminal } from 'src/utils/terminal';

const SITES = [
  'linkedin',
  'indeed',
  'zip_recruiter',
  'glassdoor',
  'google',
] as const;

const JOB_TYPES = [
  'fulltime',
  'parttime',
  'contract',
  'temporary',
  'internship',
  'perdiem',
  'nights',
  'other',
  'summer',
  'volunteer',
] as const;

/** Hard ceiling — keeps a runaway loop from burning the LLM bill. */
const MAX_ATTEMPTS = 10;
/** Auto-stop after this many consecutive attempts that added 0 new postings,
 * even if the LLM keeps saying it isn't done. Coverage has clearly plateaued. */
const MAX_CONSECUTIVE_ZERO_NEW = 50;

export function createSeedingCommand(): Command {
  return new Command('seeding')
    .description(
      'Seed SourceSeed table from <DATA_DIR>/interests.md via an LLM-driven jobspy call'
    )
    .action(() => runSeeding());
}

async function runSeeding(): Promise<void> {
  if (LLM_SEEDING_MODEL.length === 0) {
    throw new Error(
      'LLM_SEEDING_MODEL is empty — set it in jobfinder.config.js'
    );
  }

  const interests = await readSeedFile(join(DATA_DIR, 'interests.md'));
  const cv = await readSeedFile(join(DATA_DIR, 'cv.md'));

  // jobspy needs a location to scope the search (Indeed in particular returns
  // garbage when called without one), and the downstream `viewing` stage
  // scores `locationScore` against the interests file. Bail early with an
  // actionable message rather than letting an interests-without-location
  // file produce noisy results.
  const locCheck = await checkInterestsLocation(interests);
  if (!locCheck.hasLocation) {
    terminal.warn(
      `${join(DATA_DIR, 'interests.md')} does not mention any location preference.`
    );
    terminal.warn(`  Reason: ${locCheck.reason}`);

    terminal.warn(
      'Add a location (e.g. "Toronto, ON", "remote in Canada", "anywhere in EU") and re-run `jobfinder pipeline seeding`.'
    );
    return;
  }

  terminal.log(
    `Location preference detected: ${locCheck.locationsFound.join(', ') || '(see interests)'}\n`
  );

  await clearSourceSeeds();

  const inserted = await discoverSeedJobs({ interests, cv });

  terminal.log(`\nInserted ${inserted.length} rows into SourceSeed.`);
  if (inserted.length === 0) return;

  await printLlmSummary(inserted);

  terminal.log(
    [
      '',
      `Review ${join(DATA_DIR, 'interests.md')} and ${join(DATA_DIR, 'cv.md')} against the summary above.`,
      '  - Re-run `jobfinder pipeline seeding` after editing to refresh, or',
      '  - Run `jobfinder pipeline approve-seeds` to queue these seeds for sourcing.',
    ].join('\n')
  );
}

/** Drop SourceSeed rows the user never approved (no sourcing pipeline_state
 * row exists for them), along with their seeding-task state. Approved seeds
 * — and their downstream lineage — are preserved. */
async function clearSourceSeeds(): Promise<void> {
  const unapproved = await db
    .selectFrom('SourceSeed')
    .leftJoin('LatestPipelineState', join =>
      join
        .onRef('LatestPipelineState.ofSourceSeedId', '=', 'SourceSeed.id')
        .on('LatestPipelineState.task', '=', 'sourcing')
    )
    .select('SourceSeed.id as id')
    .where('LatestPipelineState.id', 'is', null)
    .execute();

  const idsToDelete = unapproved.map(r => r.id);
  if (idsToDelete.length === 0) {
    terminal.log('No unapproved SourceSeed rows to clear.');
    return;
  }

  const stateDeleted = await db
    .deleteFrom('PipelineState')
    .where('ofSourceSeedId', 'in', idsToDelete)
    .executeTakeFirst();

  const seedDeleted = await db
    .deleteFrom('SourceSeed')
    .where('id', 'in', idsToDelete)
    .executeTakeFirst();

  terminal.log(
    `Cleared ${Number(seedDeleted.numDeletedRows ?? 0n)} unapproved SourceSeed row(s) and ${Number(stateDeleted.numDeletedRows ?? 0n)} pipeline_state row(s). Approved seeds preserved.`
  );
}

async function printLlmSummary(inserted: JobResult[]): Promise<void> {
  const lines = inserted.map(
    j =>
      `- ${j.title} @ ${j.company ?? 'Unknown'} (${j.location ?? 'n/a'}) [${j.site}]`
  );

  const memory = new Memory([{ system: SEEDING_SUMMARY_SYSTEM_PROMPT }]);
  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `Seeded postings (${inserted.length}):\n\n${lines.join('\n')}`,
    schema: v.object({
      themes: v.pipe(
        v.string(),
        v.description(
          'A short paragraph (2-4 sentences) characterizing the dominant roles, levels, technologies, or locations across these postings.'
        )
      ),
      companies: v.pipe(
        v.array(v.string()),
        v.description(
          'Distinct company names appearing in the seeded postings, sorted by frequency descending.'
        )
      ),
    }),
    maxAttempts: 3,
    models: LLM_SEEDING_MODEL,
    metadata: { configKey: 'LLM_SEEDING_MODEL' },
    logger: terminal,
    validate: parsed => ({ valid: true, result: parsed }),
  });

  terminal.log(`\nSummary:\n  ${result.themes}`);
  terminal.log(`\nCompanies hiring (${result.companies.length}):`);
  for (const c of result.companies) terminal.log(`  - ${c}`);
}

async function discoverSeedJobs(args: {
  interests: string;
  cv: string;
}): Promise<JobResult[]> {
  const { interests, cv } = args;

  const memory = new Memory([{ system: SEEDING_SYSTEM_PROMPT }]);

  // Accumulate across attempts so we keep results from earlier searches even
  // as the LLM tries different terms/sites. Dedup by job_url. `inserted`
  // mirrors the SourceSeed rows actually written this run — built up
  // incrementally so a crash mid-run leaves a usable partial seed table.
  const accumulated = new Map<string, JobResult>();
  const inserted: JobResult[] = [];
  const state = { attempt: 0, consecutiveZeroNew: 0 };

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `User interests:\n\n${interests}\n\nUser CV:\n\n${cv}`,
    schema: v.object({
      done: v.pipe(
        v.boolean(),
        v.description(
          'Set true ONLY after at least one prior attempt has returned feedback AND you believe further attempts will not surface meaningfully new postings (e.g. recent attempts added 0 new rows, or you have exhausted diverse search terms). When true, the other fields are ignored.'
        )
      ),
      site_name: v.pipe(
        v.array(v.picklist(SITES)),
        v.description(
          'Job sites to scrape. Pick one or more from the supported list.'
        )
      ),
      search_term: v.pipe(
        v.string(),
        v.description(
          'Free-text search query (e.g. "senior software engineer", "data analyst"). Keep it broad enough to return results.'
        )
      ),
      location: v.pipe(
        v.nullable(v.string()),
        v.description(
          'City / state / region the user wants jobs in (e.g. "Waterloo, ON"). null if no specific location.'
        )
      ),
      country_indeed: v.pipe(
        v.nullable(v.string()),
        v.description(
          'Country code for Indeed (e.g. "usa", "canada"). null if not applicable.'
        )
      ),
      results_wanted: v.pipe(
        v.nullable(v.number()),
        v.description(
          'How many results to fetch per site. Start with 100 per page and if it fails, reduce the number.'
        )
      ),
      hours_old: v.pipe(
        v.nullable(v.number()),
        v.description(
          'Only return postings newer than this many hours. Start tight (24h) and relax (7d, 30d, then 60d) as zero-new attempts climb.'
        )
      ),
      job_type: v.pipe(
        v.nullable(v.picklist(JOB_TYPES)),
        v.description(
          'Employment type filter (fulltime, contract, internship, etc.). null means no filter.'
        )
      ),
      is_remote: v.pipe(
        v.nullable(v.boolean()),
        v.description(
          'If true, return remote-only postings. null means no remote filter.'
        )
      ),
      distance: v.pipe(
        v.nullable(v.number()),
        v.description(
          'Search radius in miles from `location`. Start with 25, then 50, 100, as zero-new attempts climb.'
        )
      ),
    }),
    maxAttempts: MAX_ATTEMPTS,
    models: LLM_SEEDING_MODEL,
    metadata: { configKey: 'LLM_SEEDING_MODEL' },
    logger: terminal,
    validate: args => runAttempt(args, state, accumulated, inserted),
  });

  return result;
}

type AttemptState = { attempt: number; consecutiveZeroNew: number };

async function runAttempt(
  args: { done: boolean } & Record<string, unknown>,
  state: AttemptState,
  accumulated: Map<string, JobResult>,
  inserted: JobResult[]
): Promise<
  { valid: true; result: JobResult[] } | { valid: false; feedback: string }
> {
  // LLM-declared stop. Honor it only after the first attempt and only if we
  // have something to insert — otherwise force at least one real scrape.
  if (args.done) {
    if (state.attempt === 0) {
      return {
        valid: false,
        feedback:
          'You cannot declare done before running any attempts. Pick a search_term and sites and try.',
      };
    }

    if (accumulated.size === 0) {
      return {
        valid: false,
        feedback:
          'You declared done but accumulated 0 postings. Run at least one more attempt with broader terms or different sites.',
      };
    }

    terminal.log(
      `\nLLM declared done after ${state.attempt} attempt(s); ${accumulated.size} unique postings.`
    );
    return { valid: true, result: inserted };
  }

  state.attempt += 1;
  const { attempt } = state;

  const { done: _done, ...rest } = args;
  void _done;
  const options = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== null)
  );

  terminal.log(
    `\nAttempt ${attempt}/${MAX_ATTEMPTS} — calling jobspy with\n${JSON.stringify(options)}`
  );

  let attemptCount = 0;
  let attemptNew = 0;
  let attemptInserted = 0;
  let crashDetail: string | null = null;
  try {
    const results = await scrapeJobs(options);
    attemptCount = results.length;
    for (const r of results) {
      if (!r.job_url || accumulated.has(r.job_url)) continue;
      accumulated.set(r.job_url, r);
      attemptNew++;
      const { inserted: didInsert } = await seedOne({ job: r });
      if (didInsert) {
        inserted.push(r);
        attemptInserted++;
      }
    }
  } catch (err) {
    crashDetail =
      err instanceof JobspyError
        ? `${err.message}\n${err.stderr}`
        : String(err);

    terminal.warn(
      '  → jobspy call crashed; feeding traceback back to the LLM as 0-result attempt.'
    );
  }

  // Crashes count as zero-new so the safety net trips after a few consecutive
  // failures — otherwise a broken env would loop until MAX_ATTEMPTS.
  if (attemptNew === 0) state.consecutiveZeroNew += 1;
  else state.consecutiveZeroNew = 0;

  if (crashDetail == null) {
    terminal.log(
      `  → ${attemptCount} results (${attemptNew} new, ${attemptInserted} inserted); ${accumulated.size} unique total, ${inserted.length} inserted total.`
    );
  }

  const exhausted = state.consecutiveZeroNew >= MAX_CONSECUTIVE_ZERO_NEW;
  const ceilingHit = attempt >= MAX_ATTEMPTS;

  if (exhausted || ceilingHit) {
    if (accumulated.size === 0) {
      return {
        valid: false,
        feedback: `All attempts returned zero unique postings (or crashed). Aborting — adjust ${join(DATA_DIR, 'interests.md')} or fix the python env.`,
      };
    }

    terminal.log(
      `\n${exhausted ? `Auto-stop after ${MAX_CONSECUTIVE_ZERO_NEW} consecutive zero-new attempts` : `Hit ceiling of ${MAX_ATTEMPTS} attempts`}; ${accumulated.size} unique postings.`
    );
    return { valid: true, result: inserted };
  }

  const feedback =
    crashDetail != null
      ? `Attempt ${attempt} CRASHED (treat as 0 new results). Read the traceback and adjust your next call — the error message often names the invalid value and the valid options. Traceback:\n${crashDetail}\n\nState: ${accumulated.size} unique postings inserted so far. Consecutive zero-new (incl. crashes): ${state.consecutiveZeroNew}/${MAX_CONSECUTIVE_ZERO_NEW}. Either fix the arguments and try again, drop the offending site/field, or set done=true if you've truly run out of angles.`
      : `Attempt ${attempt} returned ${attemptCount} results (${attemptNew} new, deduped by URL). Total inserted so far: ${accumulated.size} unique postings. Consecutive zero-new attempts: ${state.consecutiveZeroNew}/${MAX_CONSECUTIVE_ZERO_NEW}. Decide: either set done=true (if you believe further attempts won't surface new postings), or pick a different search_term and/or site mix and try again. Avoid repeating queries.`;

  return { valid: false, feedback };
}

/** Ask the LLM to scan `interests` for any location preference (city,
 * region, country, "remote", "remote in X", etc.). Returns the boolean
 * verdict plus a short list of matched phrases for the log. Throws on LLM
 * failure — `runSeeding` will surface that as a normal error. */
async function checkInterestsLocation(interests: string): Promise<{
  hasLocation: boolean;
  locationsFound: string[];
  reason: string;
}> {
  const memory = new Memory([
    {
      system: `You read a user's free-form interests file (markdown) and decide whether it states any preference about WHERE the user wants to work — a city, region, country, "remote", "remote in {region}", "anywhere in {area}", or similar. Output:
- "hasLocation": true if ANY location signal is present; false only when the file is silent on location.
- "locationsFound": short list of the location-related phrases / values you found (e.g. ["Toronto", "Remote in Canada"]). Empty array when hasLocation=false.
- "reason": one short sentence explaining what you found (or what is missing).`,
    },
  ]);

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `Interests file:\n\n${interests || '(empty)'}`,
    schema: v.object({
      hasLocation: v.pipe(
        v.boolean(),
        v.description(
          'true if the file mentions any location preference (city, region, country, "remote", etc.); false otherwise.'
        )
      ),
      locationsFound: v.pipe(
        v.array(v.string()),
        v.description(
          'Short list of the location-related phrases found in the file. Empty when hasLocation=false.'
        )
      ),
      reason: v.pipe(
        v.string(),
        v.description('One short sentence explaining the verdict.')
      ),
    }),
    maxAttempts: 2,
    models: LLM_SEEDING_MODEL,
    metadata: { configKey: 'LLM_SEEDING_MODEL' },
    logger: terminal,
    validate: parsed => ({ valid: true, result: parsed }),
  });

  return result;
}

/** Read `path`, preferring a sibling `*.local.md` if it has non-empty trimmed content. */
async function readSeedFile(path: string): Promise<string> {
  const localPath = path.replace(/\.md$/, '.local.md');
  try {
    const local = (await readFile(localPath, 'utf-8')).trim();
    if (local) return local;
  } catch {
    // local file absent — fall through to base
  }

  return readFile(path, 'utf-8');
}

// Sourcing is NOT auto-enqueued: the user reviews the inserted seeds (and
// their interests/CV) and runs `pipeline approve-seeds` to release them.
async function seedOne(args: {
  job: JobResult;
}): Promise<{ inserted: boolean }> {
  const { job } = args;
  // No company name = no anchor for the downstream approve-seeds/sourcing
  // flow (which keys off SourceSeed.name to create JobSource rows). Drop
  // these instead of polluting the table with 'Unknown' aggregations.
  if (!job.company) return { inserted: false };

  const id = newId();

  // Both `SourceSeed.url` and `SourceSeed.name` are UNIQUE. Two scrapes
  // (across runs OR within the same sweep) will often surface the same
  // posting URL, and many postings will share a company name — do-nothing
  // on any unique conflict and skip the pipeline-state write when the row
  // already exists, so its original `seeding/done` history stays intact.
  const result = await db
    .insertInto('SourceSeed')
    .values({
      id,
      url: job.job_url,
      name: job.company,
      title: job.title,
    })
    .onConflict(oc => oc.doNothing())
    .executeTakeFirst();

  const wasInserted = (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
  if (!wasInserted) return { inserted: false };

  await recordPipelineState({
    task: 'seeding',
    state: PIPELINE_STATE.DONE,
    entity: { ofSourceSeedId: id },
  });
  return { inserted: true };
}
