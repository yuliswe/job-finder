import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { resolve } from 'node:path';

import { Env } from 'src/utils/env.js';

/** Absolute path of the per-database pipeline lockfile. Keyed by the resolved
 * DB path so two pipelines pointed at different databases never block each
 * other — the contention we guard against (double-processing, the stale-
 * `started` reap mistaking a live run's rows for orphans) is entirely
 * per-database. Matches the gitignored `*.db.*` pattern. */
function lockPathFor(dbPath: string): string {
  return `${resolve(dbPath)}.pipeline.lock`;
}

/** True iff a process with `pid` currently exists. `process.kill(pid, 0)`
 * sends no signal; it only performs the permission/existence check. `ESRCH`
 * means the process is gone (a stale lock); `EPERM` means it exists but is
 * owned by another user, which still counts as alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type PipelineLock =
  | { acquired: true; release: () => void }
  | { acquired: false; holderPid: number };

/** Acquire the exclusive single-instance lock for the pipeline running against
 * `dbPath`. A second `start-pipeline` on the same database double-processes
 * every queued row and makes the stale-`started` reap requeue the live run's
 * in-flight rows, so we refuse to start one.
 *
 * Returns `{ acquired: true, release }` on success — `release` removes the
 * lockfile and is also registered on `process.on('exit')`, so a normal
 * completion or a signal-driven exit (which calls `process.exit`) frees it. A
 * hard kill (SIGKILL, power loss) leaves the file behind, but the next run
 * detects the dead holder and reclaims it.
 *
 * Returns `{ acquired: false, holderPid }` when a live instance already holds
 * it. Pass `force` to steal the lock regardless — the escape hatch for when
 * you know the recorded holder is actually dead. */
export function acquirePipelineLock(
  dbPath: string = Env.DB_PATH,
  opts: { force?: boolean } = {}
): PipelineLock {
  const lockPath = lockPathFor(dbPath);

  // Bounded so a pathological create/remove race can never spin forever; each
  // iteration either acquires, reports a live holder, or clears one stale file.
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return { acquired: true, release: makeRelease(lockPath) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;

      const holderPid = readHolderPid(lockPath);
      if (holderPid == null) continue; // vanished between open and read — retry

      if (
        !opts.force &&
        holderPid !== process.pid &&
        isProcessAlive(holderPid)
      ) {
        return { acquired: false, holderPid };
      }

      // Stale holder (dead, unreadable, or force-override) — clear and retry.
      try {
        unlinkSync(lockPath);
      } catch {
        // Another instance removed it first; the next iteration retries.
      }
    }
  }

  throw new Error(
    `Could not acquire the pipeline lock at ${lockPath} after repeated retries.`
  );
}

/** Read the PID recorded in the lockfile, or null if it is missing or
 * unparseable (treated as stale by the caller). */
function readHolderPid(lockPath: string): number | null {
  try {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Build an idempotent releaser that removes the lockfile only while it is
 * still ours, and register it on process exit so the lock is freed even when
 * the interrupt handler calls `process.exit`. */
function makeRelease(lockPath: string): () => void {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (readHolderPid(lockPath) === process.pid) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already gone — nothing to do.
      }
    }
  };

  process.once('exit', release);
  return release;
}
