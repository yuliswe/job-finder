import { createHash } from 'node:crypto';

import { toJsonSchema } from '@valibot/to-json-schema';
import { AUTO_CHOOSE_NEXT_MODEL_AFTER_N_ATTEMPTS } from 'jobfinder.config.js';
import pLimit, { type LimitFunction } from 'p-limit';
import * as v from 'valibot';

import type {
  LlmMessage,
  LlmReasoningEffort,
} from 'src/llm/plugins/interface.js';
import { AnthropicSdkPlugin } from 'src/llm/plugins/anthropicSdk.js';
import type { LlmPlugin } from 'src/llm/plugins/interface.js';
import { OllamaPlugin } from 'src/llm/plugins/ollama.js';
import { OpenRouterPlugin } from 'src/llm/plugins/openRouter.js';
import { Env, type LlmPluginName } from 'src/utils/env.js';
import { COLOURS, type Terminal } from 'src/utils/terminal';

// Single plugin instance picked at module load based on
// `jobfinder.config.js#LLM_PLUGIN`. Provider switch is global — all
// pipeline tasks talk to the same backend.
const plugin: LlmPlugin = createPlugin(Env.LLM_PLUGIN);

function createPlugin(name: LlmPluginName): LlmPlugin {
  switch (name) {
    case 'openrouter':
      return new OpenRouterPlugin();
    case 'anthropic':
      return new AnthropicSdkPlugin();
    case 'ollama':
      return new OllamaPlugin();
  }
}

/** Process-wide cap on simultaneous `plugin.send(...)` calls. `null` =
 * unlimited (the limit fn is just bypassed in `llmSend`). See
 * `resolveLlmConcurrency` for the resolution order. */
const sendLimit: LimitFunction | null = (() => {
  const cap = resolveLlmConcurrency(
    Env.LLM_PLUGIN,
    Env.LLM_REQUEST_CONCURRENCY_MAX
  );

  return cap == null ? null : pLimit(cap);
})();

/** Resolve the effective concurrency cap for `plugin.send(...)`:
 *  1. Explicit `LLM_REQUEST_CONCURRENCY_MAX` always wins.
 *  2. Otherwise, Ollama defaults to 1 — local daemons serialize
 *     inference anyway and parallel requests just thrash GPU memory.
 *  3. Otherwise, `null` (unlimited; the provider's own rate limits
 *     are the only cap). */
function resolveLlmConcurrency(
  pluginName: LlmPluginName,
  explicit: number | undefined
): number | null {
  if (explicit !== undefined) return explicit;
  if (pluginName === 'ollama') return 1;
  return null;
}

/** Thrown when the provider returns a successful HTTP response with no content
 * (e.g. upstream model filtered the request or hit an internal timeout). Named
 * so the retry loop in `sendWithRetry` can distinguish it from a hard failure. */
export class LlmEmptyResponseError extends Error {
  constructor() {
    super('LLM returned empty response');
    this.name = 'LlmEmptyResponseError';
  }
}

const schemaNameCache = new WeakMap<v.GenericSchema, string>();

function getSchemaName(schema: v.GenericSchema): string {
  let name = schemaNameCache.get(schema);
  if (!name) {
    const json = JSON.stringify(toJsonSchema(schema));
    name = 's_' + createHash('sha256').update(json).digest('hex').slice(0, 12);
    schemaNameCache.set(schema, name);
  }

  return name;
}

/** Add additionalProperties: false, require every key, and inject `type` into
 * anyOf branches that lack it — all needed for OpenAI strict mode. */
function strictifyJsonSchema(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...obj };
  delete result.$schema;

  if (result.type === 'object') {
    result.additionalProperties = false;
    if (result.properties) {
      const props = result.properties as Record<string, unknown>;

      result.properties = Object.fromEntries(
        Object.entries(props).map(([k, val]) => [
          k,
          typeof val === 'object' && val !== null
            ? strictifyJsonSchema(val as Record<string, unknown>)
            : val,
        ])
      );
      result.required = Object.keys(props);
    }
  }

  if (
    result.type === 'array' &&
    typeof result.items === 'object' &&
    result.items !== null
  ) {
    result.items = strictifyJsonSchema(result.items as Record<string, unknown>);
  }

  // anyOf branches must each declare `type` for OpenAI strict mode. Recurse
  // into every branch and infer `type` from a `const` literal when missing
  // (the most common case — `v.union([v.literal(...), ...])` from valibot).
  if (Array.isArray(result.anyOf)) {
    result.anyOf = (result.anyOf as unknown[]).map(branch => {
      if (typeof branch !== 'object' || branch === null) return branch;
      const b = branch as Record<string, unknown>;
      const strictified = strictifyJsonSchema(b);
      if (strictified.type === undefined && 'const' in strictified) {
        const constValue = strictified.const;
        const inferred =
          typeof constValue === 'string'
            ? 'string'
            : typeof constValue === 'number'
              ? 'number'
              : typeof constValue === 'boolean'
                ? 'boolean'
                : constValue === null
                  ? 'null'
                  : undefined;

        if (inferred) strictified.type = inferred;
      }

      return strictified;
    });
  }

  return result;
}

type MemoryInit = ({ system: string } | { user: string })[];

export class Memory {
  private messages: LlmMessage[] = [];

  constructor(init: MemoryInit) {
    this.messages = init.map(m =>
      'system' in m
        ? { role: 'system' as const, content: m.system }
        : { role: 'user' as const, content: m.user }
    );
  }

  add(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  addAssistant(content: string): void {
    this.messages.push({ role: 'assistant', content });
  }

  toMessages(): LlmMessage[] {
    return this.messages;
  }
}

export type ValidateResult<R> =
  | { valid: true; result: R }
  | { valid: false; feedback: string };

/** Single LLM call. Sends messages, parses and validates response against schema. */
async function llmSend<S extends v.GenericSchema>(args: {
  schema: S;
  model: string;
  messages: LlmMessage[];
  reasoningEffort?: LlmReasoningEffort;
  metadata?: Record<string, string>;
  enableWebSearch?: boolean;
}): Promise<{ result: v.InferOutput<S>; totalTokens: number }> {
  const {
    schema,
    model,
    messages,
    reasoningEffort,
    metadata,
    enableWebSearch,
  } = args;

  const responseFormat = {
    name: getSchemaName(schema),
    schema: strictifyJsonSchema(
      toJsonSchema(schema) as Record<string, unknown>
    ),
  };

  const schemaBlock = `\n\n# Required response format\n\nYour response MUST be a single JSON object validating against this schema (descriptions explain each field; read them carefully):\n\n\`\`\`json\n${JSON.stringify(responseFormat.schema, null, 2)}\n\`\`\``;
  const messagesWithSchema = appendToLastSystemMessage(messages, schemaBlock);
  const doSend = (): Promise<{ content: string; totalTokens: number }> =>
    plugin.send({
      model,
      messages: messagesWithSchema,
      reasoningEffort,
      responseFormat,
      metadata,
      enableWebSearch,
    });

  const { content, totalTokens } = sendLimit
    ? await sendLimit(doSend)
    : await doSend();

  if (!content) throw new LlmEmptyResponseError();
  const extracted = extractJson(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (err) {
    // Annotate JSON.parse failures with the raw payload (and a window around
    // the reported position) so the retry log shows what came back, not just
    // "Unterminated string at position N". The SyntaxError keeps its name +
    // message so the upstream `isSchemaError` retry path still fires, and
    // the `window` field is what the retry-feedback memo includes for the
    // model so it can see exactly where its output went wrong.
    if (err instanceof SyntaxError) {
      const e = err as SyntaxError & {
        rawContent?: string;
        extractedContent?: string;
        window?: string;
      };

      e.rawContent = content;
      e.extractedContent = extracted;
      e.window = windowAroundPosition(extracted, err.message);
    }

    throw err;
  }

  const result = v.parse(schema, parsed);
  return { result, totalTokens };
}

/** Pull "position N" out of a JSON.parse error message and return a slice of
 * `text` around N (± 120 chars). Returns the full text when no position can
 * be extracted, or when the text is already short. */
function windowAroundPosition(text: string, message: string): string {
  const RADIUS = 120;
  const match = /position\s+(\d+)/i.exec(message);
  if (!match || text.length <= RADIUS * 2) return text;
  const pos = Number(match[1]!);
  const start = Math.max(0, pos - RADIUS);
  const end = Math.min(text.length, pos + RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  // Mark the exact offset with ◆ so the eye lands on it.
  const before = text.slice(start, pos);
  const after = text.slice(pos, end);
  return `${prefix}${before}◆${after}${suffix}`;
}

/** Pull the JSON object out of an LLM response that may also contain prose
 * preamble or markdown fences. Tries three things in order:
 *   1. Strip a wrapping ```json … ``` (or bare ``` … ```) fence.
 *   2. Pull the contents of the first ```json … ``` fence anywhere in the text.
 *   3. Fall back to the first `{` through the last `}`.
 * If none of those match, return the content as-is and let `JSON.parse` throw
 * with a meaningful error. The schema is an object at the root, so first-`{`
 * to last-`}` is a safe slice — escaped `}` inside string values still leaves
 * the very last `}` as the document terminator. When the model closes early
 * and appends extra fields outside the close, JSON.parse fails at a precise
 * position; the caller annotates that with a window and feeds it back to the
 * model so it can see exactly where its output went wrong. */
function extractJson(content: string): string {
  const trimmed = content.trim();

  const wrapped = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (wrapped) return wrapped[1]!.trim();

  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fence) return fence[1]!.trim();

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

/**
 * Return a copy of `messages` with `suffix` appended to the last leading
 * `system` message. If there is no system message, prepend one carrying the
 * suffix.
 */
function appendToLastSystemMessage(
  messages: LlmMessage[],
  suffix: string
): LlmMessage[] {
  let lastSystemIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'system') lastSystemIdx = i;
    else break;
  }

  if (lastSystemIdx === -1) {
    return [{ role: 'system', content: suffix.trimStart() }, ...messages];
  }

  return messages.map((m, i) =>
    i === lastSystemIdx ? { ...m, content: m.content + suffix } : m
  );
}

class ModelInterator {
  private index = 0;
  constructor(public models: string[]) {
    if (models.length === 0) {
      throw new Error('ModelInterator: models array is empty');
    }
  }

  current(): string {
    return this.models[this.index]!;
  }

  isLast(): boolean {
    return this.index >= this.models.length - 1;
  }

  /** Name of the model we'd advance to. Caller must check !isLastModel() first. */
  peekNext(): string {
    return this.models[this.index + 1]!;
  }

  next(): void {
    if (!this.isLast()) {
      this.index++;
    }
  }
}

/** Send with retries on transient/validation failures. Cycles through
 * `models` in order: each model gets up to
 * `AUTO_CHOOSE_NEXT_MODEL_AFTER_N_ATTEMPTS` attempts before falling back
 * to the next model in the array. When every model is exhausted, the
 * last error is thrown. */
async function sendWithRetry<S extends v.GenericSchema>(args: {
  memory: Memory;
  schema: S;
  modelIterator: ModelInterator;
  logger: Terminal;
  reasoningEffort?: LlmReasoningEffort;
  metadata?: Record<string, string>;
  enableWebSearch?: boolean;
}): Promise<{
  result: v.InferOutput<S>;
  totalTokens: number;
  model: string;
}> {
  const {
    memory,
    schema,
    modelIterator,
    logger,
    reasoningEffort,
    metadata,
    enableWebSearch,
  } = args;

  const perModel = AUTO_CHOOSE_NEXT_MODEL_AFTER_N_ATTEMPTS;
  let totalTokens = 0;

  while (true) {
    const model = modelIterator.current();
    const isLastModel = modelIterator.isLast();

    for (let attempt = 0; attempt < perModel; attempt++) {
      try {
        const sendResult = await llmSend({
          schema,
          model,
          messages: memory.toMessages(),
          reasoningEffort,
          metadata,
          enableWebSearch,
        });

        totalTokens += sendResult.totalTokens;
        return {
          result: sendResult.result,
          totalTokens,
          model,
        };
      } catch (error) {
        const isSchemaError =
          error instanceof Error &&
          (error.name === 'ResponseValidationError' ||
            error instanceof v.ValiError ||
            error instanceof SyntaxError);

        const isNetworkError =
          error instanceof TypeError && error.message === 'terminated';

        const isEmptyResponse = error instanceof LlmEmptyResponseError;

        const isRetryable = isSchemaError || isNetworkError || isEmptyResponse;
        const isLastAttemptForModel = attempt === perModel - 1;

        // Non-retryable failures don't benefit from more attempts on the
        // same model — skip straight to the next fallback model (or throw
        // if this was the last one).
        if (!isRetryable) {
          logger.error(
            `LLM request failed (model=${model}): ${formatLlmError(error)}`
          );
          if (isLastModel) throw error;

          logger.warn(
            `Switching to next model: ${modelIterator.peekNext()}`,
            COLOURS.gray
          );

          modelIterator.next();
          break;
        }

        if (isLastAttemptForModel) {
          logger.error(
            `LLM request failed (model=${model}) after ${perModel} attempts: ${formatLlmError(error)}`
          );
          if (isLastModel) throw error;

          logger.warn(
            `Switching to next model: ${modelIterator.peekNext()}`,
            COLOURS.gray
          );

          modelIterator.next();
          break;
        }

        logger.error(
          `LLM request failed (model=${model}), retrying (${attempt + 1}/${perModel}): ${formatLlmError(error)}`
        );

        if (isSchemaError) {
          // Surface the actual validation/parse message so the model knows
          // what was wrong, not just that "something" was wrong. For
          // JSON.parse SyntaxErrors the `window` annotation (set in
          // `llmSend`) shows a ± 120 char slice around the failure
          // position with a ◆ marker — far more steerable than a generic
          // "please respond with valid JSON" hint.
          const detail = error instanceof Error ? error.message : String(error);
          const window = (error as { window?: string } | undefined)?.window;
          const positionHint = window
            ? `\n\nThe parse failed here (◆ marks the offending position):\n${window}`
            : '';

          memory.add(
            `Your previous response failed validation: ${detail}${positionHint}\nRespond again with a single JSON object matching the schema. Emit only the JSON object — no preamble, no trailing content, no extra fields outside the closing brace.`
          );
        } else if (isEmptyResponse) {
          memory.add(
            'Your previous response was empty. Please reply now with the required JSON object.'
          );
        }
      }
    }
  }
}

/** Surface as much of the underlying provider's error as we can. SDK errors
 * like `BadRequestResponseError` stringify to just their name + a generic
 * message ("Provider returned error"); the actual upstream reason lives on
 * shape-dependent properties (`body`, `response`, `cause`, etc.). Walk the
 * common ones and serialize what we find. */
function formatLlmError(error: unknown): string {
  const parts: string[] = [String(error)];
  const e = error as Record<string, unknown>;
  for (const key of ['status', 'statusCode', 'code']) {
    if (e && e[key] !== undefined) parts.push(`${key}=${String(e[key])}`);
  }

  for (const key of [
    'body',
    'response',
    'data',
    'error',
    'cause',
    'window',
    'extractedContent',
    'rawContent',
  ]) {
    if (e && e[key] !== undefined) {
      const value = e[key];
      const serialized =
        typeof value === 'string' ? value : safeStringify(value);

      parts.push(`${key}=${serialized}`);
    }
  }

  return parts.join(' | ');
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Send messages to the LLM, validate the response, feed back errors, retry up to maxAttempts. */
export async function feedbackLoop<
  S extends v.GenericSchema,
  R = v.InferOutput<S>,
>(args: {
  memory: Memory;
  initialPrompt: string;
  schema: S;
  maxAttempts: number;
  logger: Terminal;
  /** Fallback chain of model IDs. `llmSend` always tries index 0 first
   * and only advances when the current model has failed
   * `AUTO_CHOOSE_NEXT_MODEL_AFTER_N_ATTEMPTS` times in a row. */
  models: string[];
  validate: (
    parsed: v.InferOutput<S>,
    context: {
      iteration: number;
      model: string;
    }
  ) => Promise<ValidateResult<R>> | ValidateResult<R>;
  reasoningEffort?: LlmReasoningEffort;
  /** Free-form tags forwarded to the OpenRouter `metadata` field on every
   * underlying request — used for per-task cost analytics. */
  metadata?: Record<string, string>;
  /** When true, attach the provider's native web-search tool so the LLM can
   * search before answering. On OpenRouter this becomes `plugins:[{id:'web'}]`. */
  enableWebSearch?: boolean;
}): Promise<{ result: R; totalTokens: number }> {
  const {
    memory,
    initialPrompt,
    schema,
    validate,
    maxAttempts,
    logger,
    models,
    reasoningEffort,
    metadata,
    enableWebSearch,
  } = args;

  memory.add(initialPrompt);

  let totalTokens = 0;
  const modelIterator = new ModelInterator(models);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const sendResult = await sendWithRetry({
      memory,
      schema,
      modelIterator,
      logger,
      reasoningEffort,
      metadata,
      enableWebSearch,
    });

    totalTokens += sendResult.totalTokens;

    memory.addAssistant(JSON.stringify(sendResult.result));

    const validateResult = await validate(sendResult.result, {
      iteration: attempt,
      model: sendResult.model,
    });

    if (validateResult.valid) {
      return { result: validateResult.result, totalTokens };
    }

    const { feedback } = validateResult;

    logger.warn(
      `Attempt ${attempt}/${maxAttempts} failed. Telling LLM to revise: "${feedback}"`,
      COLOURS.gray
    );

    if (attempt < maxAttempts) {
      memory.add(feedback);
    } else {
      logger.error(
        `All ${maxAttempts} attempts failed. No more retries left. Lasts LLM response was:\n${JSON.stringify(sendResult.result, null, 2)}`
      );
    }
  }

  throw new Error(`Failed to get valid response after ${maxAttempts} attempts`);
}
