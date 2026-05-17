import { readFile } from 'node:fs/promises';

import { Command } from 'commander';
import * as v from 'valibot';

import { db } from 'src/db/index.js';
import { newId } from 'src/db/id.js';
import { recordPipelineState } from 'src/db/pipelineState.js';
import {
  enqueueTrigger,
  markTriggerProcessed,
} from 'src/db/pipelineTrigger.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { LLM_SEEDING_MODEL } from 'jobfinder.config.js';
import { SEEDING_SYSTEM_PROMPT } from 'src/prompts/seeding.js';
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

      const memory = new Memory([{ system: SEEDING_SYSTEM_PROMPT }]);

      const { result: jobs } = await feedbackLoop({
        memory,
        initialPrompt: `User interests:\n\n${interests}\n\nUser CV:\n\n${cv}`,
        schema: v.object({
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
              'How many results to fetch per site. null lets jobspy use its default (~15).'
            )
          ),
          hours_old: v.pipe(
            v.nullable(v.number()),
            v.description(
              'Only return postings newer than this many hours. null means no recency filter.'
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
              'Search radius in miles from `location`. null lets jobspy use its default (~50).'
            )
          ),
        }),
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
    const id = newId();
    try {
      await db
        .insertInto('SourceSeed')
        .values({
          id,
          url: j.job_url,
          name: j.company ?? 'Unknown',
          title: j.title,
        })
        .execute();
      inserted++;
      await recordPipelineState({
        task: 'seeding',
        state: 'done',
        entity: { ofSourceSeedId: id },
      });
      await enqueueTrigger({
        task: 'sourcing',
        entity: { ofSourceSeedId: id },
      });
      // Seeding "completes" the moment the row exists — nothing further to do
      // for that task. Mark it processed inline so progress reflects reality.
      await markTriggerProcessed({
        task: 'seeding',
        entity: { ofSourceSeedId: id },
      });
    } catch {
      // unique-url collision or other insert error — skip
    }
  }
  return inserted;
}
