import { fetchWithTimeout } from 'src/utils/fetchWithTimeout.js';
import { terminal } from 'src/utils/terminal.js';

const CDX_BASE = 'https://web.archive.org/cdx/search/cdx';
const TIMEOUT_MS = 10_000;

/** Query the Wayback Machine CDX API for the earliest snapshot of `url`.
 * Returns the snapshot timestamp as an ISO 8601 UTC string (e.g.
 * `"2023-04-15T08:00:00Z"`), or null when no snapshot exists, the API errors
 * out, or the request times out.
 *
 * The CDX API at `https://web.archive.org/cdx/search/cdx?url=…&output=json`
 * returns a JSON array; row 0 is the header, rows 1..N are matches sorted
 * by ascending timestamp (default). We pull the first match. Timestamps are
 * formatted `YYYYMMDDhhmmss`. */
export async function earliestWaybackSnapshot(
  url: string
): Promise<string | null> {
  const params = new URLSearchParams({
    url,
    output: 'json',
    limit: '1',
    // Cheap optimization: we only need the timestamp column.
    fl: 'timestamp',
  });

  try {
    const res = await fetchWithTimeout(`${CDX_BASE}?${params.toString()}`, {
      timeoutMs: TIMEOUT_MS,
    });

    if (!res.ok) {
      terminal.warn(
        `Wayback Machine CDX returned ${res.status} for ${url}; skipping`
      );
      return null;
    }

    const body = (await res.json()) as unknown;
    if (!Array.isArray(body) || body.length < 2) return null;
    const firstMatch = body[1];
    if (!Array.isArray(firstMatch) || typeof firstMatch[0] !== 'string') {
      return null;
    }

    return parseWaybackTimestamp(firstMatch[0]);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      terminal.warn(`Wayback Machine CDX timed out for ${url}`);
    } else {
      terminal.warn(`Wayback Machine CDX failed for ${url}: ${String(err)}`);
    }

    return null;
  }
}

/** Parse a `YYYYMMDDhhmmss` Wayback timestamp into an ISO 8601 UTC string.
 * Returns null on malformed input. */
function parseWaybackTimestamp(ts: string): string | null {
  if (!/^\d{14}$/.test(ts)) return null;
  const year = ts.slice(0, 4);
  const month = ts.slice(4, 6);
  const day = ts.slice(6, 8);
  const hour = ts.slice(8, 10);
  const minute = ts.slice(10, 12);
  const second = ts.slice(12, 14);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}
