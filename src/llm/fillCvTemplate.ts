import * as v from 'valibot';

import { LLM_CV_TEMPLATE_MODEL } from 'jobfinder.config.js';
import { feedbackLoop, Memory } from 'src/llm/base.js';
import type { SkillRequirements } from 'src/llm/viewJobPost.js';
import { FILL_CV_TEMPLATE_SYSTEM_PROMPT } from 'src/prompts/fillCvTemplate.js';
import { terminal, type Terminal } from 'src/utils/terminal.js';
import { getUserCV, getUserCvTemplate } from 'src/utils/userInterests.js';

const MAX_ATTEMPTS = 2;

export type FillCvTemplateResult = {
  /** Complete `<!DOCTYPE html>…</html>` document, ATS-sanitized. */
  html: string;
  /** Counts of ATS-unsafe characters replaced during sanitization, keyed by
   * label (`em-dash`, `smart-double-quote`, `zero-width`, …). Empty when the
   * LLM produced clean output. */
  sanitizations: Record<string, number>;
};

/**
 * Ask the LLM to fill `<DATA_DIR>/cv-template.html` for a specific job
 * posting, then ATS-sanitize the result. Reads the user's cv.md and the
 * HTML template directly from the data dir (no caller-side plumbing).
 *
 * The model is asked to:
 * - substitute every `{{TOKEN}}` in the template,
 * - rewrite the summary + competencies + bullet ordering toward the JD,
 * - inject JD keywords ONLY when the cv already substantiates them.
 *
 * Throws if cv.md or cv-template.html are missing/empty — both are required.
 */
export async function fillCvTemplate(args: {
  skillRequirements: SkillRequirements;
  job: {
    title: string;
    description: string;
    location?: string | null;
    isRemote?: number | null;
  };
  /** Where feedbackLoop's retry/failure messages go. Defaults to the global
   * `terminal` (stdout). The TUI passes a capturing logger so progress shows
   * inside the ink screen instead of corrupting the render. */
  logger?: Terminal;
}): Promise<FillCvTemplateResult> {
  const { skillRequirements, job, logger = terminal } = args;

  const [cv, template] = await Promise.all([getUserCV(), getUserCvTemplate()]);

  if (!cv) {
    throw new Error(
      'cv.md is empty or missing in DATA_DIR — cannot fill the CV template.'
    );
  }

  if (!template) {
    throw new Error(
      'cv-template.html is empty or missing in DATA_DIR — cannot fill the CV template.'
    );
  }

  const isRemoteLabel =
    job.isRemote == null ? 'unknown' : job.isRemote ? 'yes' : 'no';

  const skillsBlock = skillRequirements
    .map(
      (s, i) =>
        `${i + 1}. "${s.skill}" — importance ${s.importance.toFixed(2)} (${s.reason})`
    )
    .join('\n');

  const memory = new Memory([{ system: FILL_CV_TEMPLATE_SYSTEM_PROMPT }]);

  const { result } = await feedbackLoop({
    memory,
    initialPrompt: `User CV (cv.md, ground truth — do not contradict):

${cv}

HTML template (substitute every {{TOKEN}}; do not modify <style> or surrounding structure):

${template}

Job title: ${job.title}
Job location: ${job.location || '(not given)'}
Is remote: ${isRemoteLabel}

Job description:

${job.description}

Skills the posting asks for (pre-extracted, in priority order):
${skillsBlock || '(none)'}

Fill the template now and return { "html": "..." }.`,
    schema: v.object({
      html: v.pipe(
        v.string(),
        v.description(
          'The full filled HTML document as a single string. Must start with `<!DOCTYPE html>` and end with `</html>`. No surrounding prose, no markdown fences inside.'
        )
      ),
    }),
    maxAttempts: MAX_ATTEMPTS,
    models: LLM_CV_TEMPLATE_MODEL,
    metadata: { configKey: 'LLM_CV_TEMPLATE_MODEL' },
    logger,
    validate: parsed => {
      const trimmed = parsed.html.trim();
      if (!/^<!DOCTYPE html>/i.test(trimmed)) {
        return {
          valid: false,
          feedback:
            'The html field must start with `<!DOCTYPE html>`. Reply with the full document, no markdown fences, no preamble.',
        };
      }

      if (!/<\/html>\s*$/i.test(trimmed)) {
        return {
          valid: false,
          feedback:
            'The html field must end with `</html>`. Make sure you returned the complete document.',
        };
      }

      const remainingTokens = trimmed.match(/\{\{[A-Z_]+\}\}/g);
      if (remainingTokens && remainingTokens.length > 0) {
        return {
          valid: false,
          feedback: `The following template tokens were not substituted: ${[...new Set(remainingTokens)].join(', ')}. Every {{TOKEN}} must be replaced.`,
        };
      }

      return { valid: true, result: trimmed };
    },
  });

  const { html, sanitizations } = normalizeTextForATS(result);
  return { html, sanitizations };
}

/** Replace ATS-unsafe Unicode in body text only — masks <style>/<script>
 * blocks AND tag attributes so URLs, CSS, and JS keep their original
 * characters. Ported from career-ops/generate-pdf.mjs. */
function normalizeTextForATS(html: string): {
  html: string;
  sanitizations: Record<string, number>;
} {
  const sanitizations: Record<string, number> = {};
  const bump = (key: string, n: number): void => {
    sanitizations[key] = (sanitizations[key] ?? 0) + n;
  };

  // 1. Mask <style>…</style> and <script>…</script> so their contents are
  // untouched (CSS unicode-range values look exactly like targets we'd
  // rewrite, but we mustn't touch them).
  const masks: string[] = [];
  const masked = html.replace(
    /<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi,
    match => {
      const token = `\u0000MASK${masks.length}\u0000`;
      masks.push(match);
      return token;
    }
  );

  // 2. Walk character-by-character, sanitizing text segments only (skipping
  // anything between `<` and `>`).
  let out = '';
  let i = 0;
  while (i < masked.length) {
    const lt = masked.indexOf('<', i);
    if (lt === -1) {
      out += sanitizeText(masked.slice(i), bump);
      break;
    }

    out += sanitizeText(masked.slice(i, lt), bump);
    const gt = masked.indexOf('>', lt);
    if (gt === -1) {
      out += masked.slice(lt);
      break;
    }

    out += masked.slice(lt, gt + 1);
    i = gt + 1;
  }

  const restored = out.replace(
    /\u0000MASK(\d+)\u0000/g,
    (_, n) => masks[Number(n)]!
  );

  return { html: restored, sanitizations };
}

function sanitizeText(
  text: string,
  bump: (key: string, n: number) => void
): string {
  let t = text;

  t = t.replace(/\u2014/g, () => {
    bump('em-dash', 1);
    return '-';
  });

  t = t.replace(/\u2013/g, () => {
    bump('en-dash', 1);
    return '-';
  });

  t = t.replace(/[\u201C\u201D\u201E\u201F]/g, () => {
    bump('smart-double-quote', 1);
    return '"';
  });

  t = t.replace(/[\u2018\u2019\u201A\u201B]/g, () => {
    bump('smart-single-quote', 1);
    return "'";
  });

  t = t.replace(/\u2026/g, () => {
    bump('ellipsis', 1);
    return '...';
  });

  t = t.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, () => {
    bump('zero-width', 1);
    return '';
  });

  t = t.replace(/\u00A0/g, () => {
    bump('nbsp', 1);
    return ' ';
  });

  return t;
}
