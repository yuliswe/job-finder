import { readFile } from 'node:fs/promises';

/** Read `seeds/<name>.local.md` if non-empty, else `seeds/<name>.md`, else ''. */
async function readSeed(name: string): Promise<string> {
  for (const path of [`seeds/${name}.local.md`, `seeds/${name}.md`]) {
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
 * Return the user's interests text, preferring `seeds/interests.local.md`
 * (gitignored, real preferences) over the checked-in `seeds/interests.md`
 * placeholder. Returns the empty string if neither file exists or both are
 * empty.
 */
export async function getUserInterests(): Promise<string> {
  return readSeed('interests');
}

/** Same as `getUserInterests`, but for `seeds/cv.md` / `seeds/cv.local.md`. */
export async function getUserCV(): Promise<string> {
  return readSeed('cv');
}
