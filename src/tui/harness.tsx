import { EventEmitter } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';

import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';

import { App, type AppOptions } from 'src/tui/App.js';

/**
 * A harness server that lets an agent drive the live TUI without a real
 * terminal. The dashboard is rendered into an in-memory stdout (whose latest
 * frame is readable at any moment) and an injectable stdin (into which
 * keystrokes are fed). A small HTTP server exposes two capabilities:
 *
 *   GET  /screen  -> plain-text snapshot of the current frame
 *   POST /keys    -> inject keystrokes, then return the settled frame
 *
 * Unlike `captureApp` (one-shot snapshot), the App stays mounted for the
 * lifetime of the server, so its 1s SQLite polling keeps the frame live and
 * keystrokes flow into the same `useInput` handlers a human would trigger.
 */

const noop = (): void => {
  // Intentionally inert.
};

/**
 * Fake stdout that records every frame Ink writes. Ink writes the full frame on
 * each render (standard, non-incremental mode); we keep the latest one and
 * strip ANSI to recover the plain-text screen on demand.
 */
class HarnessStdout extends EventEmitter {
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

  /** Current screen as plain text, with trailing blank lines collapsed. */
  screen(): string {
    return stripAnsi(this.lastFrame).replace(/\n+$/, '\n');
  }
}

/**
 * Fake stdin that reports raw-mode support so `useInput` mounts, and lets the
 * server push keystrokes. Ink listens for the `readable` event and drains via
 * `read()` (see ink/build/components/App.js), so `push` queues a chunk and
 * emits `readable`; `read` returns the queued chunks and null when empty.
 */
class HarnessStdin extends EventEmitter {
  readonly isTTY = true;
  #queue: string[] = [];

  write = () => true;
  setEncoding = noop;
  setRawMode = noop;
  resume = noop;
  pause = noop;
  ref = noop;
  unref = noop;

  read = (): string | null => this.#queue.shift() ?? null;

  push(data: string): void {
    this.#queue.push(data);
    this.emit('readable');
  }
}

/**
 * Named keys mapped to the raw byte sequences a terminal emits for them. Ink's
 * input parser turns these back into the `key` flags (key.upArrow, key.escape,
 * …) that the TUI's `useInput` handlers check. Anything not in this table is
 * sent through literally, one character at a time.
 */
const KEY_SEQUENCES: Record<string, string> = {
  enter: '\r',
  return: '\r',
  tab: '\t',
  escape: '\x1B',
  esc: '\x1B',
  space: ' ',
  backspace: '\x7F',
  delete: '\x1B[3~',
  up: '\x1B[A',
  down: '\x1B[B',
  right: '\x1B[C',
  left: '\x1B[D',
  pageup: '\x1B[5~',
  pagedown: '\x1B[6~',
  home: '\x1B[H',
  end: '\x1B[F',
  'ctrl+c': '\x03',
};

/**
 * Resolve one key token to the bytes to inject. A token is either a named key
 * (case-insensitive, e.g. "down", "enter", "ctrl+c") or a literal string typed
 * verbatim (e.g. "q", "hello").
 */
function tokenToBytes(token: string): string {
  return KEY_SEQUENCES[token.toLowerCase()] ?? token;
}

export type HarnessKeysRequest = {
  /**
   * Key tokens to inject in order. Each is a named key ("down", "enter",
   * "escape", "tab", "ctrl+c", …) or a literal string typed verbatim.
   */
  keys?: string[];
  /** Literal text to type, each character sent as its own key. */
  text?: string;
  /** ms to wait for the App to re-render before snapshotting (default 60). */
  settle?: number;
};

const DEFAULT_SETTLE_MS = 60;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Give up waiting for the first populated frame after this long. */
const READY_TIMEOUT_MS = 8000;

export type HarnessServer = {
  /** Base URL the server is listening on, e.g. http://127.0.0.1:5599. */
  url: string;
  port: number;
  /** Current screen as plain text. */
  screen(): string;
  /** Inject keystrokes and return the frame after `settle` ms. */
  sendKeys(request: HarnessKeysRequest): Promise<string>;
  /** Resolves when the TUI exits (user pressed q/Esc). */
  waitUntilExit(): Promise<void>;
  /** Tear down the server and unmount the TUI. */
  close(): Promise<void>;
};

export type StartHarnessOptions = {
  host?: string;
  port?: number;
  columns?: number;
  rows?: number;
};

/**
 * Mount the dashboard against in-memory streams and start the HTTP control
 * server. Resolves once the server is listening and the first frame has
 * populated (or `READY_TIMEOUT_MS` elapses).
 */
export async function startHarnessServer(
  appOptions: AppOptions,
  { host = '127.0.0.1', port = 0, columns, rows }: StartHarnessOptions = {}
): Promise<HarnessServer> {
  const cols = columns ?? process.stdout.columns ?? 120;
  const lines = rows ?? process.stdout.rows ?? 40;
  const stdout = new HarnessStdout(cols, lines);
  const stdin = new HarnessStdin();

  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => {
    resolveReady = resolve;
  });

  const instance = render(<App initial={appOptions} onReady={resolveReady} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  const sendKeys = async (request: HarnessKeysRequest): Promise<string> => {
    for (const token of request.keys ?? []) {
      stdin.push(tokenToBytes(token));
    }

    for (const char of request.text ?? '') {
      stdin.push(char);
    }

    await delay(request.settle ?? DEFAULT_SETTLE_MS);
    return stdout.screen();
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, stdout, sendKeys).catch(err => {
      sendJson(res, 500, { error: String(err) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address() as AddressInfo;
  const boundPort = address.port;
  const url = `http://${host}:${boundPort}`;

  // Wait for the first fully-populated frame so an immediate /screen read is
  // meaningful, but don't hang if a query errors and onReady never fires.
  await Promise.race([ready, delay(READY_TIMEOUT_MS)]);
  await delay(50);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>(resolve => server.close(() => resolve()));
    instance.unmount();
  };

  // When the user quits from inside the TUI, tear the server down too.
  const exited = instance.waitUntilExit().then(close);

  return {
    url,
    port: boundPort,
    screen: () => stdout.screen(),
    sendKeys,
    waitUntilExit: () => exited,
    close,
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  stdout: HarnessStdout,
  sendKeys: (request: HarnessKeysRequest) => Promise<string>
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/' || path === '/help')) {
    sendJson(res, 200, {
      endpoints: {
        'GET /screen': 'plain-text snapshot of the current dashboard frame',
        'POST /keys':
          'inject keystrokes and return the resulting frame; body: { keys?: string[], text?: string, settle?: number }',
      },
      keyNames: Object.keys(KEY_SEQUENCES),
    });
    return;
  }

  if (req.method === 'GET' && path === '/screen') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(stdout.screen());
    return;
  }

  if (req.method === 'POST' && path === '/keys') {
    const body = await readBody(req);
    const request: HarnessKeysRequest = body ? JSON.parse(body) : {};
    if (
      request.keys != null &&
      (!Array.isArray(request.keys) ||
        request.keys.some(k => typeof k !== 'string'))
    ) {
      sendJson(res, 400, { error: '`keys` must be an array of strings' });
      return;
    }

    const screen = await sendKeys(request);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(screen);
    return;
  }

  sendJson(res, 404, { error: `no route for ${req.method} ${path}` });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}
