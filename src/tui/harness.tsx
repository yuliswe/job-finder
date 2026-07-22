import { EventEmitter } from 'node:events';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';

import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';

import { App, type AppOptions } from 'src/tui/App.js';

/**
 * A harness server that lets an agent drive the live TUI. The dashboard is
 * rendered against instrumented streams and a small HTTP server exposes two
 * capabilities:
 *
 *   GET  /screen  -> plain-text snapshot of the current frame
 *   POST /keys    -> inject keystrokes, then return the settled frame
 *
 * Unlike `captureApp` (one-shot snapshot), the App stays mounted for the
 * lifetime of the server, so its 1s SQLite polling keeps the frame live and
 * keystrokes flow into the same `useInput` handlers a human would trigger.
 *
 * When invoked from a real terminal the streams *mirror* it: every frame Ink
 * draws is also written to the terminal (so a human watches the same TUI) and
 * the human's own keystrokes are forwarded alongside injected ones. When
 * stdout is not a TTY (piped, or a pure headless agent) the streams stay fully
 * in-memory and nothing is drawn.
 */

/**
 * Stdout that records the latest frame Ink writes and, when a real terminal is
 * attached, mirrors every frame to it. Ink writes the full frame on each render
 * (standard, non-incremental mode), so the last write is always the whole
 * screen; we strip ANSI to recover its plain text on demand.
 */
class HarnessStdout extends Writable {
  lastFrame = '';
  readonly #real: NodeJS.WriteStream | null;
  readonly #columns: number;
  readonly #rows: number;

  constructor(real: NodeJS.WriteStream | null, columns: number, rows: number) {
    // A real Writable is used (rather than a bare fake) so Ink's teardown path
    // works natively: on unmount Ink resolves `waitUntilExit` from the
    // `write(chunk, callback)` completion callback, which a genuine Writable
    // delivers and a hand-rolled object does not.
    super({ decodeStrings: false });
    this.#real = real;
    this.#columns = columns;
    this.#rows = rows;
    // Ink listens for 'resize' on the stdout stream to re-layout; forward the
    // real terminal's resize events through this proxy.
    real?.on('resize', () => this.emit('resize'));
  }

  get columns(): number {
    return this.#real?.columns ?? this.#columns;
  }

  get rows(): number {
    return this.#real?.rows ?? this.#rows;
  }

  // Undefined (falsy) in headless mode, so Ink writes plain full frames; true
  // when mirroring a terminal, so Ink drives it exactly like the live TUI.
  get isTTY(): boolean | undefined {
    return this.#real?.isTTY;
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    const frame = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    // Keep only writes that carry visible text. On a TTY, Ink brackets each
    // frame with content-free control writes — a synchronized-update start/end
    // pair and cursor-only sequences — and its final barrier write is an empty
    // string; capturing any of those would blank out the frame that /screen
    // reports. Everything is still forwarded to the real terminal below.
    if (stripAnsi(frame).trim() !== '') this.lastFrame = frame;
    if (this.#real) {
      this.#real.write(frame, callback);
      return;
    }

    callback();
  }

  /** Current screen as plain text, with trailing blank lines collapsed. */
  screen(): string {
    return stripAnsi(this.lastFrame).replace(/\n+$/, '\n');
  }
}

/**
 * Stdin that lets the server push keystrokes and, when a real terminal is
 * attached, forwards the human's keystrokes too. Ink listens for the `readable`
 * event and drains via `read()` (see ink/build/components/App.js), so both
 * `push` and the forwarded terminal data queue a chunk and emit `readable`;
 * `read` returns the queued chunks and null when empty.
 *
 * With no real stdin the proxy still reports `isTTY` so `useInput` mounts and
 * raw-mode toggles are no-ops — the App renders and only injected keys drive it.
 */
class HarnessStdin extends EventEmitter {
  readonly isTTY: boolean = true;
  readonly #real: NodeJS.ReadStream | null;
  #queue: string[] = [];

  constructor(real: NodeJS.ReadStream | null) {
    super();
    this.#real = real;
    if (real?.isTTY != null) this.isTTY = real.isTTY;
  }

  #onRealData = (chunk: string): void => {
    this.#queue.push(chunk);
    this.emit('readable');
  };

  write = (): boolean => true;

  setEncoding = (encoding: BufferEncoding): void => {
    this.#real?.setEncoding(encoding);
  };

  // Ink enables raw mode when a component uses input and disables it on
  // unmount. Mirror that onto the real terminal, and only start forwarding the
  // human's keystrokes once raw mode is on (so cooked line-buffered input never
  // leaks through and echoes over the TUI).
  setRawMode = (enabled: boolean): void => {
    if (!this.#real) return;
    if (this.#real.isTTY) this.#real.setRawMode(enabled);
    if (enabled) {
      this.#real.on('data', this.#onRealData);
      this.#real.resume();
    } else {
      this.#real.off('data', this.#onRealData);
    }
  };

  resume = (): void => {
    this.#real?.resume();
  };

  pause = (): void => {
    this.#real?.pause();
  };

  ref = (): void => {
    this.#real?.ref();
  };

  unref = (): void => {
    this.#real?.unref();
  };

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
  /**
   * Called once the server is listening, before the TUI is rendered. Use it to
   * print the base URL: in a terminal the TUI takes over the screen right after
   * this, so anything printed later would corrupt the display.
   */
  onListening?: (url: string) => void;
  /**
   * Called synchronously during teardown, after the server is closed and the
   * quit response has flushed. The CLI wires this to `process.exit(0)`: exiting
   * here is reliable, whereas awaiting `waitUntilExit()` and then exiting is
   * not, because the promise continuation can be starved by the event-loop
   * stall Ink leaves behind after processing injected input with no further I/O.
   */
  onQuit?: () => void;
};

/**
 * Mount the dashboard, start the HTTP control server, and resolve once it is
 * listening and the first frame has populated (or `READY_TIMEOUT_MS` elapses).
 *
 * When stdout is a real terminal the TUI is mirrored to it and the human's
 * keystrokes are forwarded; otherwise the streams stay headless and only
 * injected keys drive the App.
 */
export async function startHarnessServer(
  appOptions: AppOptions,
  {
    host = '127.0.0.1',
    port = 0,
    columns,
    rows,
    onListening,
    onQuit,
  }: StartHarnessOptions = {}
): Promise<HarnessServer> {
  const realStdout = process.stdout.isTTY ? process.stdout : null;
  const realStdin = process.stdin.isTTY ? process.stdin : null;
  const cols = columns ?? process.stdout.columns ?? 120;
  const lines = rows ?? process.stdout.rows ?? 40;
  const stdout = new HarnessStdout(realStdout, cols, lines);
  const stdin = new HarnessStdin(realStdin);

  // `userQuit` is set the instant the App quits (q/Esc); `injecting` is true
  // while a key batch is being applied. Together they let teardown wait until
  // the quit request's own HTTP response has flushed (see the /keys handler and
  // `onExit` below).
  let userQuit = false;
  let injecting = false;

  let resolveExited!: () => void;
  const exited = new Promise<void>(resolve => {
    resolveExited = resolve;
  });

  let tornDown = false;
  // Teardown is synchronous and driven by an I/O completion (the flushed HTTP
  // response, or a keystroke), never a wall-clock timer: after the App unmounts
  // it clears its polling interval, and a fresh `setTimeout` registered then can
  // fire seconds late because the event loop is parked in the poll phase.
  // `closeAllConnections` forces every socket shut so `server.close` can't hang.
  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    server.closeAllConnections();
    server.close();
    // Resolve for programmatic callers, then hand control to onQuit (the CLI's
    // synchronous `process.exit(0)`). onQuit runs before `instance.unmount()`
    // because Ink's unmount schedules async exit work that can stall the event
    // loop against our injected streams; a synchronous exit here sidesteps it.
    resolveExited();
    onQuit?.();
    instance.unmount();
  };

  const injectKeys = async (request: HarnessKeysRequest): Promise<string> => {
    injecting = true;
    try {
      const settle = request.settle ?? DEFAULT_SETTLE_MS;
      const chars = request.text ? [...request.text] : [];
      const bytes = [...(request.keys ?? []).map(tokenToBytes), ...chars];
      // Deliver keys one at a time, pausing for a re-render between each, so a
      // batch behaves like a real sequence of presses. Pushing them all at once
      // would let every handler read the same pre-render state (e.g. two
      // "right"s would both switch away from the starting tab).
      for (const chunk of bytes) {
        stdin.push(chunk);
        await delay(settle);
      }

      if (bytes.length === 0) await delay(settle);
      return stdout.screen();
    } finally {
      injecting = false;
    }
  };

  // Public API: apply keys and, if they quit the TUI, tear down afterwards
  // (a programmatic caller has already received the returned frame by then).
  const sendKeys = async (request: HarnessKeysRequest): Promise<string> => {
    const screen = await injectKeys(request);
    if (userQuit) teardown();
    return screen;
  };

  // Fired synchronously by the App when the user quits. If a key batch is being
  // injected, defer teardown to whoever is applying it (the /keys handler flushes
  // its response first); otherwise the quit came from the terminal keyboard, so
  // tear down now.
  const onExit = (): void => {
    userQuit = true;
    if (!injecting) teardown();
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, {
      stdout,
      injectKeys,
      finalize: teardown,
      isQuitPending: () => userQuit,
    }).catch(err => {
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

  // Announce the URL before Ink claims the terminal — see onListening's doc.
  onListening?.(url);

  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => {
    resolveReady = resolve;
  });

  const instance = render(
    <App initial={appOptions} onReady={resolveReady} onExit={onExit} />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      exitOnCtrlC: false,
      patchConsole: false,
    }
  );

  // Wait for the first fully-populated frame so an immediate /screen read is
  // meaningful, but don't hang if a query errors and onReady never fires.
  await Promise.race([ready, delay(READY_TIMEOUT_MS)]);
  await delay(50);

  return {
    url,
    port: boundPort,
    screen: () => stdout.screen(),
    sendKeys,
    waitUntilExit: () => exited,
    close: async () => teardown(),
  };
}

type RequestContext = {
  stdout: HarnessStdout;
  injectKeys: (request: HarnessKeysRequest) => Promise<string>;
  isQuitPending: () => boolean;
  finalize: () => void;
};

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext
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
    res.end(ctx.stdout.screen());
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

    const screen = await ctx.injectKeys(request);
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    // If those keys quit the TUI, tear the server down only after this response
    // has flushed, so the caller still receives the final frame.
    res.end(screen, ctx.isQuitPending() ? ctx.finalize : undefined);
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
