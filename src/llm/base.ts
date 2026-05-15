import { createHash } from 'node:crypto';

import { toJsonSchema } from '@valibot/to-json-schema';
import * as v from 'valibot';

import { plugin } from 'jobfinder.config.js';
import type {
  LlmMessage,
  LlmReasoningEffort,
} from 'src/llm/plugins/interface.js';
import { COLOURS, type Terminal } from 'src/utils/terminal';

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

/** Add additionalProperties: false and require every key — needed for OpenAI strict mode. */
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
export async function llmSend<S extends v.GenericSchema>(args: {
  schema: S;
  model: string;
  messages: LlmMessage[];
  reasoningEffort?: LlmReasoningEffort;
}): Promise<{ result: v.InferOutput<S>; totalTokens: number }> {
  const { schema, model, messages, reasoningEffort } = args;
  const responseFormat = {
    name: getSchemaName(schema),
    schema: strictifyJsonSchema(
      toJsonSchema(schema) as Record<string, unknown>
    ),
  };
  const { content, totalTokens } = await plugin.send({
    model,
    messages,
    reasoningEffort,
    responseFormat,
  });
  if (!content) throw new Error('LLM returned empty response');
  const result = v.parse(schema, JSON.parse(content));
  return { result, totalTokens };
}

const MAX_SEND_RETRIES = 5;

/** Send with retries on transient/validation failures. Returns parsed result. */
export async function sendWithRetry<S extends v.GenericSchema>(args: {
  memory: Memory;
  schema: S;
  model: string;
  logger: Terminal;
  reasoningEffort?: LlmReasoningEffort;
}): Promise<{ result: v.InferOutput<S>; totalTokens: number }> {
  const { memory, schema, model, logger, reasoningEffort } = args;

  let totalTokens = 0;
  for (let retry = 0; retry < MAX_SEND_RETRIES; retry++) {
    try {
      const sendResult = await llmSend({
        schema,
        model,
        messages: memory.toMessages(),
        reasoningEffort,
      });
      totalTokens += sendResult.totalTokens;
      return { result: sendResult.result, totalTokens };
    } catch (error) {
      const isRetryable =
        error instanceof Error &&
        (error.name === 'ResponseValidationError' ||
          error instanceof v.ValiError);

      if (isRetryable && retry < MAX_SEND_RETRIES - 1) {
        logger.error(
          `LLM request failed (model=${model}), retrying (${retry + 1}/${MAX_SEND_RETRIES}): ${String(error)}`
        );
        memory.add(
          'Your previous response was not valid or did not match the expected schema. Please respond with valid JSON only, matching the required schema exactly.'
        );
        continue;
      }

      logger.error(`LLM request failed (model=${model}): ${String(error)}`);
      throw error;
    }
  }

  throw new Error('Unreachable');
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
  model: string;
  validate: (
    parsed: v.InferOutput<S>
  ) => Promise<ValidateResult<R>> | ValidateResult<R>;
  reasoningEffort?: LlmReasoningEffort;
}): Promise<{ result: R; totalTokens: number }> {
  const {
    memory,
    initialPrompt,
    schema,
    validate,
    maxAttempts,
    logger,
    model,
    reasoningEffort,
  } = args;

  memory.add(initialPrompt);

  let totalTokens = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const sendResult = await sendWithRetry({
      memory,
      schema,
      model,
      logger,
      reasoningEffort,
    });
    totalTokens += sendResult.totalTokens;

    memory.addAssistant(JSON.stringify(sendResult.result));

    const validateResult = await validate(sendResult.result);

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
