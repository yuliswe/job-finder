import { Env } from 'src/utils/env.js';

export type TagOption = {
  /** Key as stored in `JobPost.tags` and as defined in TAGS config. */
  key: string;
  /** Display label from TAGS config. */
  label: string;
  /** Keyboard shortcut after pressing `t`. First letter of `key`. */
  shortcut: string;
  /** Ink color name for this tag. */
  inkColor: string;
};

/** Map TAGS config keys to Ink-renderable color names. Ink's standard
 * palette has no 'purple', so we alias it to 'magenta'; anything else
 * passes through verbatim (Ink accepts CSS color names and hex). */
export function tagInkColor(key: string): string {
  const k = key.toLowerCase();
  if (k === 'purple') return 'magenta';
  return k;
}

/** Snapshot the TAGS config into an ordered list of options. Order follows
 * the insertion order of the config object. Shortcut is the first letter
 * of each key, lowercased. */
export function listTagOptions(): TagOption[] {
  const tags = Env.TAGS;
  return Object.entries(tags).map(([key, label]) => ({
    key,
    label,
    shortcut: key.charAt(0).toLowerCase(),
    inkColor: tagInkColor(key),
  }));
}

/** Look up the option for a single tag key, falling back to a white-dot
 * stub so stale tags (key removed from config) still render. */
export function tagOption(key: string): TagOption {
  const found = listTagOptions().find(t => t.key === key);
  if (found) return found;
  return {
    key,
    label: key,
    shortcut: key.charAt(0).toLowerCase(),
    inkColor: 'white',
  };
}
