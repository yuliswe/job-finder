import { spawn } from 'node:child_process';

import type {
  LlmMessage,
  LlmRawResponse,
  LlmReasoningEffort,
  LlmSendArgs,
} from 'src/llm/plugins/interface.js';
import { Env } from 'src/utils/env.js';

/** Effort values accepted by the Claude Code CLI's `--effort` flag:
 * `low | medium | high | xhigh | max`. The interface's `minimal` has no
 * CLI equivalent, so map it down to `low` (mirrors `AnthropicSdkPlugin`).
 * The CLI additionally supports `max`, but nothing in `LlmReasoningEffort`
 * maps to it. */
const EFFORT_MAP: Record<
  LlmReasoningEffort,
  'low' | 'medium' | 'high' | 'xhigh'
> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

/** Hard cap on how long a single `claude -p` invocation may run before we
 * SIGTERM it. Matches the 10-minute ceiling the Ollama/Anthropic plugins
 * use — a subscription call carrying a large JD can be slow. */
const TIMEOUT_MS = 10 * 60_000;

/** The single-object envelope printed by `claude -p --output-format json`.
 * Only the fields this plugin reads are typed; the CLI emits many more. */
type ClaudeCliEnvelope = {
  type: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  api_error_status?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

/** Drives the local Claude Code CLI (`claude -p`) as an LLM backend, so
 * requests bill against the machine's Claude Pro/Max **subscription**
 * rather than an API key. This is the sanctioned way to use a subscription
 * programmatically: the CLI already holds the OAuth login (in the OS
 * keychain) and speaks Anthropic's client contract, which a raw API call
 * with a `setup-token` bearer cannot (it is missing the `anthropic-beta:
 * oauth-*` header the gateway requires). Contrast `AnthropicSdkPlugin`,
 * which talks to the API directly and needs `ANTHROPIC_API_KEY` /
 * `ANTHROPIC_AUTH_TOKEN`.
 *
 * Selected per model by prefixing the model id with `claudecode-plugin/`,
 * e.g. `LLM_VIEW_JOB_DETAIL_MODEL = ['claudecode-plugin/claude-opus-4-8']`. The
 * dispatcher in `src/llm/base.ts` strips the prefix before calling `send`.
 *
 * Trade-offs versus a direct API call:
 *   - **No schema-enforced JSON.** The CLI has no `output_config.format`
 *     equivalent, so `responseFormat.schema` is *not* passed to the model
 *     here. Structured output relies entirely on the harness, which injects
 *     the schema into the system prompt (`llmSend` in `base.ts`), strips any
 *     ```json fences from the reply (`extractJson`), and retries on parse /
 *     validation failure. Reliability is therefore prompt-driven, not
 *     provider-enforced.
 *   - **Per-call overhead.** Every invocation carries Claude Code's own
 *     system prompt + tool definitions (~tens of thousands of cached tokens),
 *     which inflates latency and subscription-quota usage relative to a lean
 *     API request.
 *   - **`enableWebSearch`** — the CLI *can* web-search, but this plugin
 *     disables all tools for deterministic single-shot output, so it throws
 *     (use `OpenRouterPlugin` for web-search-augmented calls). */
export class ClaudeCodeCliPlugin {
  private readonly bin: string;

  constructor(args: { bin?: string } = {}) {
    this.bin = args.bin ?? Env.CLAUDE_CODE_CLI_BIN;
  }

  async send(args: LlmSendArgs): Promise<LlmRawResponse> {
    const { model, messages, reasoningEffort } = args;
    if (args.enableWebSearch) {
      throw new Error(
        'ClaudeCodeCliPlugin: enableWebSearch is not supported (all tools are disabled for deterministic output). Use OpenRouterPlugin for web-search-augmented calls.'
      );
    }

    const { system, prompt } = splitSystemAndFlatten(messages);

    // `--allowed-tools ""` gives the model no tools to call, and
    // `--strict-mcp-config` (with no `--mcp-config`) loads none of the
    // user's MCP servers — together they keep the call a pure, hang-free
    // single-shot completion in non-interactive `-p` mode.
    const cliArgs = [
      '-p',
      '--output-format',
      'json',
      '--model',
      model,
      '--allowed-tools',
      '',
      '--strict-mcp-config',
    ];

    if (system) cliArgs.push('--system-prompt', system);
    if (reasoningEffort) cliArgs.push('--effort', EFFORT_MAP[reasoningEffort]);

    const { stdout, stderr, code, signal } = await runClaude(
      this.bin,
      cliArgs,
      prompt
    );

    if (signal) {
      throw new Error(
        `ClaudeCodeCliPlugin: \`${this.bin}\` was killed by signal ${signal} (exceeded ${TIMEOUT_MS} ms timeout)${stderr ? ` — ${stderr.trim()}` : ''}`
      );
    }

    if (code !== 0) {
      throw new Error(
        `ClaudeCodeCliPlugin: \`${this.bin}\` exited with code ${code}${stderr ? ` — ${stderr.trim()}` : ''}`
      );
    }

    const envelope = parseEnvelope(stdout, stderr);

    if (envelope.is_error || envelope.subtype !== 'success') {
      throw new Error(
        `ClaudeCodeCliPlugin: CLI reported failure (subtype=${envelope.subtype}, api_error_status=${envelope.api_error_status ?? 'null'}): ${envelope.result ?? '(no result)'}`
      );
    }

    const content = envelope.result ?? '';

    if (Env.LLM_LOG_STREAM) {
      // The `json` output format is a single blob, not a live stream, so we
      // can only echo the final text after the call completes (unlike the
      // streaming plugins). Kept for parity with `LLM_LOG_STREAM` elsewhere.
      process.stdout.write(
        `\n--- LLM (${model}) ---\n${content}\n--- end ---\n`
      );
    }

    const { usage } = envelope;
    const totalTokens =
      (usage?.input_tokens ?? 0) +
      (usage?.output_tokens ?? 0) +
      (usage?.cache_creation_input_tokens ?? 0) +
      (usage?.cache_read_input_tokens ?? 0);

    return { content, totalTokens };
  }
}

/** Split the leading `system` messages out (Claude Code takes the system
 * prompt via `--system-prompt`, not inline) and flatten the remaining
 * user/assistant turns into a single prompt string fed on stdin.
 *
 * The common case is one user turn, which passes through verbatim. When the
 * harness's retry loop has accumulated prior turns (an assistant JSON echo
 * plus a follow-up user correction), they are rendered as a labelled
 * transcript so the model still sees the conversation history — the CLI's
 * text input format has no native multi-turn channel. */
function splitSystemAndFlatten(messages: LlmMessage[]): {
  system: string | null;
  prompt: string;
} {
  const systemParts: string[] = [];
  const turns: LlmMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else turns.push(m);
  }

  const system = systemParts.length > 0 ? systemParts.join('\n\n') : null;

  const prompt =
    turns.length === 1 && turns[0]!.role === 'user'
      ? turns[0]!.content
      : turns
          .map(t => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
          .join('\n\n');

  return { system, prompt };
}

/** Parse the CLI's single-line JSON envelope from stdout. Warnings are
 * written to stderr (verified), so stdout is normally pure JSON; the
 * line-scan fallback recovers the envelope if any stray output ever leaks
 * onto stdout ahead of it. */
function parseEnvelope(stdout: string, stderr: string): ClaudeCliEnvelope {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as ClaudeCliEnvelope;
  } catch {
    for (const line of trimmed.split('\n').reverse()) {
      const s = line.trim();
      if (!s.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(s) as ClaudeCliEnvelope;
        if (parsed.type === 'result') return parsed;
      } catch {
        // keep scanning
      }
    }

    throw new Error(
      `ClaudeCodeCliPlugin: could not parse CLI output as JSON. stdout=${JSON.stringify(trimmed.slice(0, 500))}${stderr ? ` stderr=${JSON.stringify(stderr.trim().slice(0, 500))}` : ''}`
    );
  }
}

/** Spawn `claude`, write `prompt` to its stdin, and collect stdout/stderr.
 * Resolves with the raw streams plus exit `code` / `signal`; never rejects
 * on a non-zero exit (the caller inspects `code`/`signal`). Rejects only if
 * the process cannot be spawned at all (e.g. binary not found). */
function runClaude(
  bin: string,
  cliArgs: string[],
  prompt: string
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, cliArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
      killSignal: 'SIGTERM',
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));

    child.on('error', err => {
      reject(
        new Error(
          `ClaudeCodeCliPlugin: failed to spawn \`${bin}\` — ${err instanceof Error ? err.message : String(err)}. Is the Claude Code CLI installed and on PATH (or set CLAUDE_CODE_CLI_BIN)?`
        )
      );
    });

    child.on('close', (code, signal) => {
      resolve({ stdout, stderr, code, signal });
    });

    child.stdin.on('error', () => {
      // A broken pipe (child exited before reading stdin) surfaces via the
      // 'close' handler with a non-zero code; swallow the write-side error
      // so it doesn't crash the process.
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
