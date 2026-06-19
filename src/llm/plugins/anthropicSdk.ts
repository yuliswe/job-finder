import Anthropic from '@anthropic-ai/sdk';

import type {
  LlmMessage,
  LlmRawResponse,
  LlmReasoningEffort,
  LlmSendArgs,
} from 'src/llm/plugins/interface.js';
import { Env } from 'src/utils/env.js';

const DEFAULT_MAX_TOKENS = 128_000;

/** Effort values accepted by `output_config.effort` on the Anthropic API.
 * `xhigh` is Opus 4.7-only; `max` is Opus-tier (4.6+). The harness's
 * `LlmReasoningEffort` includes `minimal`, which Anthropic doesn't support —
 * map it down to `low`. */
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

export class AnthropicSdkPlugin {
  private readonly apiKeyOverride: string | undefined;
  private readonly authTokenOverride: string | undefined;
  private client: Anthropic | null = null;

  constructor(args: { apiKey?: string; authToken?: string } = {}) {
    this.apiKeyOverride = args.apiKey;
    this.authTokenOverride = args.authToken;
  }

  private getClient(): Anthropic {
    if (!this.client) {
      const apiKey = this.apiKeyOverride ?? Env.ANTHROPIC_API_KEY;
      const authToken = this.authTokenOverride ?? Env.ANTHROPIC_AUTH_TOKEN;
      if (!apiKey && !authToken) {
        throw new Error(
          'Anthropic credentials not provided. Set ANTHROPIC_API_KEY for a regular API key, or ANTHROPIC_AUTH_TOKEN for a Claude Pro/Max subscription OAuth token (mint one with `claude setup-token`).'
        );
      }

      // `authToken` takes precedence when both are set — it's the more
      // specific opt-in (subscription users often still have an old
      // `sk-ant-…` lying around in their env).
      this.client = authToken
        ? new Anthropic({ authToken })
        : new Anthropic({ apiKey });
    }

    return this.client;
  }

  async send(args: LlmSendArgs): Promise<LlmRawResponse> {
    const { model, messages, reasoningEffort, responseFormat } = args;
    if (args.enableWebSearch) {
      // Anthropic does support a `web_search` server tool, but wiring it
      // means appending a tool definition + tool_choice handling, which
      // this plugin doesn't yet do. Surface the mismatch rather than
      // silently dropping the request to web-search-enabled behavior.
      throw new Error(
        'AnthropicSdkPlugin: enableWebSearch is not yet wired up. Use OpenRouterPlugin for web-search-augmented calls.'
      );
    }

    const { system, turns } = splitSystem(messages);

    // Stream and collect via `.finalMessage()`. The SDK refuses non-streaming
    // `messages.create()` when its estimate of total response time exceeds
    // 10 min — adaptive thinking with `max_tokens=16000` on a slow model is
    // enough to trip the check. Streaming has no such limit.
    const params: Anthropic.MessageCreateParamsStreaming = {
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
      // Auto-cache the last cacheable block — tools + system together. Stable
      // prefix → repeated calls with the same system prompt hit the cache.
      cache_control: { type: 'ephemeral' },
      ...(system ? { system } : {}),
      messages: turns.map(m => ({
        role: m.role,
        content: [{ type: 'text', text: m.content }],
      })),
      output_config: {
        // Anthropic's json_schema format has no `name` field (unlike
        // OpenRouter's). `responseFormat.name` is ignored here.
        format: {
          type: 'json_schema',
          schema: responseFormat.schema,
        },
        ...(reasoningEffort ? { effort: EFFORT_MAP[reasoningEffort] } : {}),
      },
      // Adaptive thinking pairs with effort on Opus 4.6/4.7 and Sonnet 4.6.
      // Older models don't support adaptive — caller is responsible for
      // pairing the right model with reasoningEffort.
      ...(reasoningEffort ? { thinking: { type: 'adaptive' } } : {}),
      // We intentionally do not forward args.metadata: Anthropic's `metadata`
      // field accepts only `user_id`, while the interface's metadata is a
      // free-form tag bag for cost analytics (e.g. `configKey`). Dropping it
      // here keeps the request valid.
    };

    const stream = this.getClient().messages.stream(params);
    const response = await stream.finalMessage();

    const content = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const { usage } = response;
    const totalTokens =
      (usage?.input_tokens ?? 0) +
      (usage?.output_tokens ?? 0) +
      (usage?.cache_creation_input_tokens ?? 0) +
      (usage?.cache_read_input_tokens ?? 0);

    return { content, totalTokens };
  }
}

/** Anthropic's API takes `system` as a separate parameter, not as a role in
 * the messages array. Concatenate any system messages (in order) into one
 * string and emit the user/assistant turns separately. */
function splitSystem(messages: LlmMessage[]): {
  system: string | null;
  turns: { role: 'user' | 'assistant'; content: string }[];
} {
  const systemParts: string[] = [];
  const turns: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content);
    else turns.push({ role: m.role, content: m.content });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : null,
    turns,
  };
}
