import { useEffect, useRef, useState } from 'react';

import { sqlite } from 'src/db/index.js';

const POLL_MS = 150;

/** Read SQLite's `data_version` pragma. Increments on any write across connections. */
function readDataVersion(): number {
  const row = sqlite.pragma('data_version', { simple: true });
  return typeof row === 'number' ? row : Number(row);
}

/**
 * Run `fetch` on mount and again every time `PRAGMA data_version` changes
 * (i.e. some other connection wrote to the DB). Returns the latest data, or
 * `null` until the first fetch resolves. `fetch` is re-invoked sequentially —
 * if it's still in flight when the next change arrives, the new run is queued.
 *
 * better-sqlite3 doesn't expose `sqlite3_update_hook`, so we poll the
 * single-integer data_version (sub-ms read) at POLL_MS cadence. Heavy queries
 * only re-run when the version actually moves.
 */
export function useLiveData<T>(fetch: () => Promise<T>): T | null {
  const [data, setData] = useState<T | null>(null);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let queued = false;
    let lastVersion = -1;

    const run = async () => {
      if (cancelled) return;
      if (inFlight) {
        queued = true;
        return;
      }
      inFlight = true;
      try {
        const next = await fetchRef.current();
        if (!cancelled) setData(next);
      } catch {
        // Swallow query errors — the dashboard stays on the prior snapshot.
      } finally {
        inFlight = false;
        if (queued && !cancelled) {
          queued = false;
          void run();
        }
      }
    };

    // Initial fetch.
    void run();

    const interval = setInterval(() => {
      if (cancelled) return;
      const v = readDataVersion();
      if (v !== lastVersion) {
        lastVersion = v;
        void run();
      }
    }, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return data;
}
