/** Pad/truncate `s` to exactly `w` characters. Left-aligned by default
 * (padding on the right); pass `align: 'right'` to pad on the left instead,
 * which is the natural choice for numeric columns. Over-long strings are
 * truncated with an ellipsis regardless of alignment. */
export function pad(
  s: string,
  w: number,
  align: 'left' | 'right' = 'left'
): string {
  if (w <= 0) return '';
  if (s.length > w) return s.slice(0, w - 1) + '…';
  const fill = ' '.repeat(w - s.length);
  return align === 'right' ? fill + s : s + fill;
}

/**
 * Allocate column widths for a table where each column has:
 *   - `min` (mandatory): preferred floor when allocation is possible.
 *   - `max` (optional): preferred ceiling. Columns without `max` are
 *     unbounded — they absorb leftover space when the table is wider than
 *     all the content combined.
 *   - `contentMax`: width of the widest cell currently in the column.
 *   - `priority` (optional, default 0): lower number = considered first
 *     ("most important"). Columns are allocated in ascending priority order
 *     (1, 2, 3, ...). When the terminal can't fit every column's natural
 *     width, higher-numbered priority columns get whatever is left and may be
 *     squeezed below their `min` (their min/max are soft in that regime);
 *     lower-numbered priority columns always keep their natural
 *     `clamp(contentMax, min, max)` width.
 *
 * Two regimes:
 *   1. `sum(desired) <= available`: every column gets `desired`. Slack is
 *      split evenly across unbounded columns; if none exist, the slack lands
 *      on the widest column.
 *   2. `sum(desired) > available`: process columns in priority order asc
 *      (1 first, then 2, ...). Each gets `min(desired, remaining)`.
 *      Higher-numbered priority columns are squeezed (or zeroed) so the
 *      lower-numbered ones stay at their right size.
 *
 * Within the same priority, columns are processed in declared order.
 */
export function allocateContentColumns(
  available: number,
  cols: {
    contentMax: number;
    min: number;
    max?: number;
    priority?: number;
  }[]
): number[] {
  if (cols.length === 0) return [];

  const desired = cols.map(c =>
    Math.max(c.min, Math.min(c.contentMax, c.max ?? Number.POSITIVE_INFINITY))
  );

  const totalDesired = desired.reduce((s, n) => s + n, 0);

  if (totalDesired <= available) {
    const slack = available - totalDesired;
    const out = [...desired];
    // Slack goes to unbounded cols at the HIGHEST priority number (i.e. the
    // most-flexible / least-important cols). That keeps it from being smeared
    // across small score columns that happen to be unbounded.
    const unbounded: number[] = [];

    cols.forEach((c, i) => {
      if (c.max == null) unbounded.push(i);
    });
    let sinks: number[] = [];
    if (unbounded.length > 0) {
      const maxPri = Math.max(...unbounded.map(i => cols[i]!.priority ?? 0));
      sinks = unbounded.filter(i => (cols[i]!.priority ?? 0) === maxPri);
    }

    if (sinks.length === 0) {
      const widestIdx = cols.reduce(
        (best, c, i) => (c.contentMax > cols[best]!.contentMax ? i : best),
        0
      );

      sinks = [widestIdx];
    }

    const per = Math.floor(slack / sinks.length);
    const rem = slack - per * sinks.length;

    sinks.forEach((i, idx) => {
      out[i]! += per + (idx === sinks.length - 1 ? rem : 0);
    });
    return out;
  }

  // Over budget: allocate by priority ascending (1 first, then 2, ...).
  // Lower-numbered priority cols get their full desired width;
  // higher-numbered priority cols get whatever's left.
  const order = cols
    .map((_, i) => i)
    .sort((a, b) => (cols[a]!.priority ?? 0) - (cols[b]!.priority ?? 0));

  const out: number[] = new Array(cols.length).fill(0);
  let remaining = available;
  for (const i of order) {
    const take = Math.max(0, Math.min(desired[i]!, remaining));
    out[i] = take;
    remaining -= take;
  }

  return out;
}

/** Strip `https://` / `http://` and a leading `www.` for compact display
 * (the TUI typically only has 30-ish chars for the url column). Returns the
 * input unchanged when it doesn't match the prefixes. */
export function prettyUrl(url: string | null | undefined): string {
  if (!url) return '';
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

export function fmtScore(n: number | null): string {
  if (n == null) return '—';
  return n.toFixed(2);
}

export function fmtDaysAgo(
  postedAt: string | null,
  postedAtSource: 'job_post' | 'twbm' | null = null,
  now = Date.now()
): string {
  if (postedAt == null) return '—';
  const t = Date.parse(postedAt);
  if (Number.isNaN(t)) return '—';
  const days = Math.floor((now - t) / 86_400_000);
  const clamped = days < 0 ? 0 : days;
  // Wayback Machine gives us a LOWER bound (earliest indexed date), so the
  // posting is at least this old — render as `>N` to convey "older than".
  if (postedAtSource === 'twbm') return `>${clamped}`;
  return String(clamped);
}

export function fmtSalary(
  min: number | null,
  max: number | null,
  currency: string | null
): string {
  if (min == null && max == null) return '—';
  const c = currency ? ` ${currency}` : '';
  if (min != null && max != null && min !== max) return `${min}–${max}${c}`;
  return `${min ?? max}${c}`;
}

export function stateColor(
  state: string
): 'green' | 'yellow' | 'red' | 'white' {
  if (state === 'done' || state === 'success' || state === 'created')
    return 'green';
  if (state === 'failed' || state === 'script_error') return 'red';
  if (
    state === 'aborted' ||
    state === 'no_result_found' ||
    state === 'no_listing_found' ||
    state === 'no_source_found'
  )
    return 'yellow';
  return 'white';
}
