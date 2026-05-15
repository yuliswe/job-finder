import { readFile } from 'node:fs/promises';

import { Command } from 'commander';
import * as v from 'valibot';

import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { LLM_SEEDING_MODEL } from 'jobfinder.config.js';
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
  'bayt',
  'naukri',
  'bdjobs',
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

const ScrapeArgsSchema = v.object({
  site_name: v.array(v.picklist(SITES)),
  search_term: v.string(),
  location: v.nullable(v.string()),
  country_indeed: v.nullable(v.string()),
  results_wanted: v.nullable(v.number()),
  hours_old: v.nullable(v.number()),
  job_type: v.nullable(v.picklist(JOB_TYPES)),
  is_remote: v.nullable(v.boolean()),
  distance: v.nullable(v.number()),
});

const SYSTEM_PROMPT = `You translate a user's job-search interests (free-form Markdown) into a single python-jobspy scrape call.

Output JSON matching the provided schema. Pick sites and a search_term that best capture the user's interests; include location/country/job_type/is_remote/hours_old/results_wanted only when supported by the interests.

If a previous attempt fails, read the error feedback and adjust: try different sites, a broader search_term, or a different location format.`;

const MAX_ATTEMPTS = 5;

export function createSeedingCommand(): Command {
  return new Command('seeding')
    .description(
      'Seed SourceSeed table from seeds/interests.md via an LLM-driven jobspy call'
    )
    .action(async () => {
      if (!LLM_SEEDING_MODEL) {
        throw new Error(
          'LLM_SEEDING_MODEL is empty — set it in src/llm/config.ts'
        );
      }

      const interests = await readSeedFile('seeds/interests.md');
      const cv = await readSeedFile('seeds/cv.md');

      const memory = new Memory([{ system: SYSTEM_PROMPT }]);

      const { result: jobs } = await feedbackLoop({
        memory,
        initialPrompt: `User interests:\n\n${interests}\n\nUser CV:\n\n${cv}`,
        schema: ScrapeArgsSchema,
        maxAttempts: MAX_ATTEMPTS,
        model: LLM_SEEDING_MODEL,
        logger: terminal,
        validate: async args => {
          terminal.log(`Call jobspy with \n${JSON.stringify(args)}`);

          const options = Object.fromEntries(
            Object.entries(args).filter(([, value]) => value !== null)
          );
          try {
            const results = await scrapeJobs(options);
            if (results.length === 0) {
              return {
                valid: false,
                feedback:
                  'The scrape returned 0 jobs. Broaden the search_term or try different sites/locations.',
              };
            }
            return { valid: true, result: results };
          } catch (err) {
            const detail =
              err instanceof JobspyError
                ? `${err.message}\n${err.stderr}`
                : String(err);
            return {
              valid: false,
              feedback: `The scrape call failed: ${detail}\n\nFix the arguments and try again.`,
            };
          }
        },
      });

      const inserted = await insertSeeds(jobs);
      process.stdout.write(`Inserted ${inserted} rows into SourceSeed\n`);
    });
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

async function insertSeeds(jobs: JobResult[]): Promise<number> {
  const dedup = new Map<string, JobResult>();
  for (const j of jobs) {
    if (j.job_url && !dedup.has(j.job_url)) dedup.set(j.job_url, j);
  }

  let inserted = 0;
  for (const j of dedup.values()) {
    try {
      await db
        .insertInto('SourceSeed')
        .values({
          id: newId(),
          url: j.job_url,
          name: j.company ?? 'Unknown',
          title: j.title,
        })
        .execute();
      inserted++;
    } catch {
      // unique-url collision or other insert error — skip
    }
  }
  return inserted;
}
