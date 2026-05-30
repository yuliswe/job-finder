import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SEEDS_DIR } from 'jobfinder.config.js';

/** Read `<SEEDS_DIR>/<name>.local.md` if non-empty, else
 * `<SEEDS_DIR>/<name>.md`, else `''`. */
async function readSeed(name: string): Promise<string> {
  for (const path of [
    join(SEEDS_DIR, `${name}.local.md`),
    join(SEEDS_DIR, `${name}.md`),
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
 * Return the user's interests text, preferring `<SEEDS_DIR>/interests.local.md`
 * (gitignored, real preferences) over the checked-in
 * `<SEEDS_DIR>/interests.md` placeholder. Returns the empty string if neither
 * file exists or both are empty. `SEEDS_DIR` comes from `jobfinder.config.js`.
 */
export async function getUserInterests(): Promise<string> {
  return readSeed('interests');
}

/** Same as `getUserInterests`, but for `<SEEDS_DIR>/cv.md` /
 * `<SEEDS_DIR>/cv.local.md`. */
export async function getUserCV(): Promise<string> {
  return readSeed('cv');
}
