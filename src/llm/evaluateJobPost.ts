import * as v from 'valibot';

import { LLM_EVALUATION_MODEL } from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import { EVALUATE_JOB_POST_SYSTEM_PROMPT } from 'src/prompts/evaluateJobPost.js';
import { terminal } from 'src/utils/terminal';

const MAX_ATTEMPTS = 2;

export type SkillBreakdownEntry = {
  skill: string;
  importance: number;
  importanceReason: string;
  skillScore: number;
  skillScoreReason: string;
};

export type JobPostEvaluation = {
  interestScore: number;
  interestScoreReason: string;
  skillScore: number;
  skillScoreReason: string;
  skillScoreBreakdown: SkillBreakdownEntry[];
};

/**
 * Ask the LLM to score a single job posting against the user's interests + CV
 * along two axes (interest and skill), and to break the skill score down per
 * skill the posting calls for.
 */
export async function evaluateJobPost(args: {
  interests: string;
  cv: string;
  job: { title: string; description: string };
}): Promise<JobPostEvaluation> {
  const { interests, cv, job } = args;

  const memory = new Memory([{ system: EVALUATE_JOB_POST_SYSTEM_PROMPT }]);

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `User interests:

${interests || '(empty)'}

User CV:

${cv || '(empty)'}

Job title: ${job.title}

Job description:

${job.description}

Score this posting and return the structured evaluation.`,
    schema: v.object({
      interestScore: v.pipe(
        v.number(),
        v.description(
          'Score in [0, 1] of how interested the user would be in this job based on their interests file.'
        )
      ),
      interestScoreReason: v.pipe(
        v.string(),
        v.description(
          'One sentence (≤ ~200 chars) justifying interestScore, citing concrete words from the interests and the posting.'
        )
      ),
      skillScore: v.pipe(
        v.number(),
        v.description(
          'Score in [0, 1] of how well the user already has the skills/experience this job requires (per their CV).'
        )
      ),
      skillScoreReason: v.pipe(
        v.string(),
        v.description('One sentence (≤ ~200 chars) justifying skillScore.')
      ),
      skillScoreBreakdown: v.pipe(
        v.array(
          v.object({
            skill: v.pipe(
              v.string(),
              v.description(
                'Short canonical name of a skill or requirement the posting asks for.'
              )
            ),
            importance: v.pipe(
              v.number(),
              v.description(
                'How load-bearing this skill is for the role, in [0, 1]. 1.0 = must-have; 0.5 = nice-to-have; ~0.1 = mentioned in passing.'
              )
            ),
            importanceReason: v.pipe(
              v.string(),
              v.description(
                'Short justification (≤ ~140 chars), referencing where the posting calls it out.'
              )
            ),
            skillScore: v.pipe(
              v.number(),
              v.description(
                "User's demonstrable experience with THIS skill per the CV, in [0, 1]."
              )
            ),
            skillScoreReason: v.pipe(
              v.string(),
              v.description(
                'Short justification (≤ ~140 chars), citing the relevant line in the CV (or noting its absence).'
              )
            ),
          })
        ),
        v.description(
          'Per-skill breakdown. Cap at ~15 entries; focus on load-bearing skills.'
        )
      ),
    }),
    maxAttempts: MAX_ATTEMPTS,
    model: LLM_EVALUATION_MODEL,
    logger: terminal,
    validate: parsed => {
      const inRange = (n: number) => n >= 0 && n <= 1;
      if (!inRange(parsed.interestScore)) {
        return {
          valid: false,
          feedback: `interestScore must be in [0, 1]; got ${parsed.interestScore}.`,
        };
      }

      if (!inRange(parsed.skillScore)) {
        return {
          valid: false,
          feedback: `skillScore must be in [0, 1]; got ${parsed.skillScore}.`,
        };
      }

      for (const s of parsed.skillScoreBreakdown) {
        if (!inRange(s.importance) || !inRange(s.skillScore)) {
          return {
            valid: false,
            feedback: `Per-skill importance and skillScore must be in [0, 1]; offender: ${JSON.stringify(s)}.`,
          };
        }
      }
      return { valid: true, result: parsed };
    },
  });

  return result;
}
