import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DATA_DIR } from 'jobfinder.config.js';

/** Read `<DATA_DIR>/<name>.local.md` if non-empty, else
 * `<DATA_DIR>/<name>.md`, else `''`. */
async function readSeed(name: string): Promise<string> {
  for (const path of [
    join(DATA_DIR, `${name}.local.md`),
    join(DATA_DIR, `${name}.md`),
  ]) {
    try {
      const text = (await readFile(path, 'utf-8')).trim();
      if (text) return text;
    } catch {
      // file missing — try the next one
    }
  }

  return '';
}

/**
 * Return the user's interests text, preferring `<DATA_DIR>/interests.local.md`
 * (gitignored, real preferences) over the checked-in
 * `<DATA_DIR>/interests.md` placeholder. Returns the empty string if neither
 * file exists or both are empty. `DATA_DIR` comes from `jobfinder.config.js`.
 */
export async function getUserInterests(): Promise<string> {
  return readSeed('interests');
}

/** Same as `getUserInterests`, but for `<DATA_DIR>/cv.md` /
 * `<DATA_DIR>/cv.local.md`. */
export async function getUserCV(): Promise<string> {
  return readSeed('cv');
}

/** Read `<DATA_DIR>/cv-template.local.html` if non-empty, else
 * `<DATA_DIR>/cv-template.html`. The template uses `{{TOKEN}}` placeholders
 * (`{{NAME}}`, `{{SUMMARY_TEXT}}`, `{{EXPERIENCE}}`, etc.) that
 * `fillCvTemplate` asks an LLM to populate per job posting. */
export async function getUserCvTemplate(): Promise<string> {
  for (const path of [
    join(DATA_DIR, 'cv-template.local.html'),
    join(DATA_DIR, 'cv-template.html'),
  ]) {
    try {
      const text = (await readFile(path, 'utf-8')).trim();
      if (text) return text;
    } catch {
      // file missing — try the next one
    }
  }

  return '';
}
