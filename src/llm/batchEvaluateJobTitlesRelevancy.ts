import * as v from 'valibot';

import { LLM_LISTING_MODEL } from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { BATCH_EVALUATE_JOB_TITLES_RELEVANCY_SYSTEM_PROMPT } from 'src/prompts/batchEvaluateJobTitlesRelevancy.js';
import { terminal } from 'src/utils/terminal';

const MAX_ATTEMPTS = 5;

/** Send candidates to the LLM in chunks so a single huge batch can't blow the context window. */
const BATCH_SIZE = 50;

export type JobRelevanceScore = {
  titleRelavency: number | null;
  titleRelavencyReason: string;
};

/**
 * Score `candidates` against `interests` in batches. Returns one score per
 * input, in the same order.
 */
export async function batchEvaluateJobTitlesRelevancy(args: {
  interests: string;
  candidates: { jobTitle: string; url: string }[];
}): Promise<JobRelevanceScore[]> {
  const { interests, candidates } = args;

  if (candidates.length === 0) return [];
  if (!interests.trim()) {
    throw new Error('Interests string is empty; cannot evaluate relevancy.');
  }

  const out: JobRelevanceScore[] = new Array(candidates.length);

  for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
    const batch = candidates.slice(start, start + BATCH_SIZE);
    const scores = await scoreBatch({ interests, batch });
    for (let i = 0; i < batch.length; i++) {
      out[start + i] = scores[i]!;
    }
  }

  return out;
}

async function scoreBatch(args: {
  interests: string;
  batch: { jobTitle: string; url: string }[];
}): Promise<JobRelevanceScore[]> {
  const { interests, batch } = args;

  const memory = new Memory([
    { system: BATCH_EVALUATE_JOB_TITLES_RELEVANCY_SYSTEM_PROMPT },
  ]);

  const indexed = batch.map((c, i) => ({ index: i, ...c }));

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `User interests:

${interests}

Candidate jobs (${batch.length}):
${indexed.map(c => `${c.index}. ${c.jobTitle} — ${c.url}`).join('\n')}

Score each entry by TITLE relevance only. Return one score per index, in order.`,
    schema: v.object({
      scores: v.pipe(
        v.array(
          v.object({
            index: v.pipe(
              v.number(),
              v.description(
                'The integer index this score refers to (matches the input index).'
              )
            ),
            titleRelavency: v.pipe(
              v.number(),
              v.description(
                'Relevance score in [0, 1] inclusive. See the rubric in the system prompt.'
              )
            ),
            titleRelavencyReason: v.pipe(
              v.string(),
              v.description(
                'One short sentence (≤ ~140 chars) explaining why you gave this score, referencing concrete words from the title and the user interests.'
              )
            ),
          })
        ),
        v.description(
          'One entry per input index, in the same order. Length MUST equal the number of input candidates.'
        )
      ),
    }),
    maxAttempts: MAX_ATTEMPTS,
    model: LLM_LISTING_MODEL,
    logger: terminal,
    validate: parsed => {
      if (parsed.scores.length !== batch.length) {
        return {
          valid: false,
          feedback: `You returned ${parsed.scores.length} scores but there were ${batch.length} candidates. Return exactly one score per candidate.`,
        };
      }
      for (const s of parsed.scores) {
        if (s.titleRelavency < 0 || s.titleRelavency > 1) {
          return {
            valid: false,
            feedback: `titleRelavency must be in [0, 1]; got ${s.titleRelavency} at index ${s.index}. Clamp and resend.`,
          };
        }
      }
      // Place by index so position matches the caller's order even if the LLM
      // returned them out of order.
      const result: JobRelevanceScore[] = new Array(batch.length);
      for (const s of parsed.scores) {
        if (s.index < 0 || s.index >= batch.length) {
          return {
            valid: false,
            feedback: `index ${s.index} is out of range [0, ${batch.length}). Return one score per input index.`,
          };
        }
        if (result[s.index] !== undefined) {
          return {
            valid: false,
            feedback: `index ${s.index} appeared more than once. Return exactly one score per input index.`,
          };
        }
        result[s.index] = {
          titleRelavency: s.titleRelavency,
          titleRelavencyReason: s.titleRelavencyReason,
        };
      }
      return { valid: true, result };
    },
  });

  return result;
}
