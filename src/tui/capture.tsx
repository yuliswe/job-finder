import { EventEmitter } from 'node:events';

import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';

import { App, type AppOptions } from 'src/tui/App.js';

/**
 * Fake stdout that records every frame Ink writes instead of driving a real
 * terminal. Ink writes the full frame on each render (standard, non-incremental
 * mode), wrapped in cursor/erase escapes and interspersed with color codes.
 * We keep the last write and strip ANSI to recover the plain-text screen.
 */
class CaptureStdout extends EventEmitter {
  readonly columns: number;
  readonly rows: number;
  lastFrame = '';

  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  write = (frame: string): boolean => {
    this.lastFrame = frame;
    return true;
  };
}

/**
 * Fake stdin that reports raw-mode support so `useInput` mounts without
 * throwing. It never emits data, so the App simply renders and idles.
 */
const noop = (): void => {
  // Intentionally inert: nothing consumes this fake stdin.
};

class CaptureStdin extends EventEmitter {
  readonly isTTY = true;
  write = () => true;
  setEncoding = noop;
  setRawMode = noop;
  resume = noop;
  pause = noop;
  ref = noop;
  unref = noop;
  read = () => null;
}

/** Give up waiting for data after this long and snapshot whatever is on screen. */
const READY_TIMEOUT_MS = 8000;

/**
 * Render the dashboard once, wait for its async SQLite reads to resolve, and
 * return a plain-text snapshot of the final frame. Used by
 * `jobfinder tui --non-interactive` so an agent can read the same view a human
 * sees without an interactive terminal.
 *
 * The App calls `onReady` on the first render where every data source has
 * loaded. If a query errors (its result is swallowed and stays null) `onReady`
 * never fires, so we cap the wait and snapshot the partial frame rather than
 * hang.
 */
export async function captureApp(options: AppOptions): Promise<string> {
  const columns = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? 40;
  const stdout = new CaptureStdout(columns, rows);
  const stdin = new CaptureStdin();

  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => {
    resolveReady = resolve;
  });

  const instance = render(<App initial={options} onReady={resolveReady} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  await Promise.race([ready, delay(READY_TIMEOUT_MS)]);
  // Let Ink flush the frame that reflects the just-loaded data before reading.
  await delay(50);
  instance.unmount();

  return stripAnsi(stdout.lastFrame).replace(/\n+$/, '\n');
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
