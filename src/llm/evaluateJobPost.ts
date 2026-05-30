import * as v from 'valibot';

import { LLM_EVALUATION_MODEL } from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import type { SkillRequirements } from 'src/llm/viewJobPost.js';
import { EVALUATE_JOB_POST_SYSTEM_PROMPT } from 'src/prompts/evaluateJobPost.js';
import { terminal } from 'src/utils/terminal';

const MAX_ATTEMPTS = 2;

export type SkillBreakdownEntry = {
  skill: string;
  skillScore: number;
  skillScoreReason: string;
};

export type JobPostEvaluation = {
  interestScore: number;
  interestScoreReason: string;
  skillScore: number;
  skillScoreReason: string;
  skillScoreBreakdown: SkillBreakdownEntry[];
  locationScore: number;
  locationScoreReason: string;
};

/**
 * Ask the LLM to score a single job posting against the user's interests + CV
 * along three axes (interest, skill, location). The set of skills under
 * consideration comes from the posting-derived `skillRequirements` (extracted
 * at viewing time, CV-free); here the LLM only scores the user's experience
 * with each. Location is scored against the location preferences expressed
 * in the interests file vs the posting's location + remote status.
 */
export async function evaluateJobPost(args: {
  interests: string;
  cv: string;
  job: {
    title: string;
    description: string;
    location: string | null;
    isRemote: number | null;
  };
  skillRequirements: SkillRequirements;
}): Promise<JobPostEvaluation> {
  const { interests, cv, job, skillRequirements } = args;

  const isRemoteLabel =
    job.isRemote === null ? 'unknown' : job.isRemote ? 'yes' : 'no';

  const memory = new Memory([{ system: EVALUATE_JOB_POST_SYSTEM_PROMPT }]);

  const skillsBlock = skillRequirements
    .map(
      (s, i) =>
        `${i + 1}. "${s.skill}" — importance ${s.importance.toFixed(2)} (${s.reason})`
    )
    .join('\n');

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `User interests:

${interests || '(empty)'}

User CV:

${cv || '(empty)'}

Job title: ${job.title}

Job location: ${job.location || '(not given)'}
Is remote: ${isRemoteLabel}

Job description:

${job.description}

Skills the posting asks for (pre-extracted, in priority order):
${skillsBlock || '(none)'}

Score this posting and return the structured evaluation. For skillScores, return one entry for every skill listed above — no more, no fewer — using the EXACT skill name strings from the list (do not rename, paraphrase, or merge).`,
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
      skillScores: v.pipe(
        v.array(
          v.object({
            skill: v.pipe(
              v.string(),
              v.description(
                'Exact skill name copied from the input skillRequirements list.'
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
          'One entry for every skill in the input skillRequirements, using the EXACT skill name strings. Each input skill must appear exactly once; do not add, rename, or omit any.'
        )
      ),
      locationScore: v.pipe(
        v.number(),
        v.description(
          "Score in [0, 1] of how well the posting's location (and remote status) fits the user's location preferences from the interests file. 0.5 when the posting's location is unknown or the user has no stated preference."
        )
      ),
      locationScoreReason: v.pipe(
        v.string(),
        v.description(
          "One sentence (≤ ~200 chars) justifying locationScore, citing the user's stated location preference (or its absence) and the posting's location / remote status."
        )
      ),
    }),
    maxAttempts: MAX_ATTEMPTS,
    model: LLM_EVALUATION_MODEL,
    metadata: { configKey: 'LLM_EVALUATION_MODEL' },
    logger: terminal,
    validate: parsed => {
      const inRange = (n: number) => n >= 0 && n <= 1;
      if (!inRange(parsed.interestScore)) {
        return {
          valid: false,
          feedback: `interestScore must be in [0, 1]; got ${parsed.interestScore}.`,
        };
      }

      if (!inRange(parsed.locationScore)) {
        return {
          valid: false,
          feedback: `locationScore must be in [0, 1]; got ${parsed.locationScore}.`,
        };
      }

      if (!parsed.locationScoreReason.trim()) {
        return {
          valid: false,
          feedback:
            'locationScoreReason must be a non-empty sentence citing the user-stated location preference (or its absence) and the posting location.',
        };
      }

      const expected = new Set(skillRequirements.map(s => s.skill));
      const seen = new Set<string>();
      const duplicates: string[] = [];
      const unknown: string[] = [];

      for (const got of parsed.skillScores) {
        if (!expected.has(got.skill)) {
          unknown.push(got.skill);
          continue;
        }

        if (seen.has(got.skill)) {
          duplicates.push(got.skill);
          continue;
        }

        seen.add(got.skill);
        if (!inRange(got.skillScore)) {
          return {
            valid: false,
            feedback: `skillScores entry for "${got.skill}" has skillScore ${got.skillScore}; must be in [0, 1].`,
          };
        }
      }

      if (unknown.length > 0) {
        return {
          valid: false,
          feedback: `skillScores contains skill names not in the input skillRequirements: ${unknown.map(s => `"${s}"`).join(', ')}. Use the EXACT skill names from the input — do not rename, paraphrase, or invent.`,
        };
      }

      if (duplicates.length > 0) {
        return {
          valid: false,
          feedback: `skillScores has duplicate entries for: ${duplicates.map(s => `"${s}"`).join(', ')}. Each input skill must appear exactly once.`,
        };
      }

      const missing = [...expected].filter(s => !seen.has(s));
      if (missing.length > 0) {
        return {
          valid: false,
          feedback: `skillScores is missing entries for: ${missing.map(s => `"${s}"`).join(', ')}. Every skill in the input skillRequirements must be scored.`,
        };
      }

      return { valid: true, result: parsed };
    },
  });

  // Index the LLM scores by skill name (validator already enforced
  // exact name match + no duplicates + no missing entries).
  const scoreByName = new Map(result.skillScores.map(s => [s.skill, s]));

  const skillScoreBreakdown: SkillBreakdownEntry[] = skillRequirements.map(
    req => {
      const s = scoreByName.get(req.skill)!;
      return {
        skill: s.skill,
        skillScore: s.skillScore,
        skillScoreReason: s.skillScoreReason,
      };
    }
  );

  // skillScore is derived, not LLM-supplied: it's the importance-weighted
  // average over the (importance, skillScore) pairs, where importance comes
  // from the posting-derived skillRequirements and skillScore comes from the
  // LLM's CV match.
  const { skillScore, skillScoreReason } = aggregateSkillScore(
    skillRequirements.map(req => ({
      importance: req.importance,
      skillScore: scoreByName.get(req.skill)!.skillScore,
    }))
  );

  return {
    interestScore: result.interestScore,
    interestScoreReason: result.interestScoreReason,
    skillScore,
    skillScoreReason,
    skillScoreBreakdown,
    locationScore: result.locationScore,
    locationScoreReason: result.locationScoreReason.trim(),
  };
}

function aggregateSkillScore(
  pairs: { importance: number; skillScore: number }[]
): {
  skillScore: number;
  skillScoreReason: string;
} {
  if (pairs.length === 0) {
    return {
      skillScore: 0,
      skillScoreReason: 'No skills extracted from the posting.',
    };
  }

  let weighted = 0;
  let totalImportance = 0;
  for (const p of pairs) {
    weighted += p.importance * p.skillScore;
    totalImportance += p.importance;
  }

  if (totalImportance === 0) {
    return {
      skillScore: 0,
      skillScoreReason: `All ${pairs.length} skills had importance=0.`,
    };
  }

  const skillScore = weighted / totalImportance;
  return {
    skillScore,
    skillScoreReason: `Importance-weighted average over ${pairs.length} skill${pairs.length === 1 ? '' : 's'} (Σ importance = ${totalImportance.toFixed(2)}).`,
  };
}
