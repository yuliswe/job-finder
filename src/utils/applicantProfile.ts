import { getApplicantProfile } from 'src/utils/userInterests.js';

export type ApplicantProfile = {
  /** Raw markdown as authored, forwarded to the LLM verbatim so it can answer
   * free-text questions (cover letter, "why this company") from the narrative. */
  raw: string;
  /** Flat `key → value` map parsed from the `- key: value` lines of the
   * profile file. The generated fill-form script references these keys as
   * `profile.fields.<key>`, and the runtime passes this same object in, so the
   * script stays profile-agnostic and re-usable across posts. */
  fields: Record<string, string>;
};

/** Parse `- key: value` (or `key: value`) lines out of the profile markdown
 * into a flat map. Lines without a colon, markdown headings, and blank lines
 * are ignored. Keys are trimmed verbatim (author them in camelCase, e.g.
 * `firstName`, `workAuthorized`). */
export function parseApplicantProfileFields(
  raw: string
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.replace(/^\s*[-*]\s+/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line
      .slice(0, colon)
      .trim()
      .replace(/^\*\*|\*\*$/g, '');

    const value = line.slice(colon + 1).trim();
    if (key && value) fields[key] = value;
  }

  return fields;
}

/** Load and parse the user's applicant profile from `<DATA_DIR>/profile*.md`.
 * Throws when the file is missing/empty, since the fill-form stage cannot fill
 * anything without it. */
export async function loadApplicantProfile(): Promise<ApplicantProfile> {
  const raw = await getApplicantProfile();
  if (!raw) {
    throw new Error(
      'profile.md is empty or missing in DATA_DIR — create data/profile.local.md ' +
        'with `- key: value` lines (firstName, lastName, email, phone, …) before running fill-form.'
    );
  }

  return { raw, fields: parseApplicantProfileFields(raw) };
}
