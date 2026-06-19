import { OpenRouter } from '@openrouter/sdk';

import type { LlmRawResponse, LlmSendArgs } from 'src/llm/plugins/interface.js';
import { Env } from 'src/utils/env.js';

export class OpenRouterPlugin {
  private readonly apiKeyOverride: string | undefined;
  private client: OpenRouter | null = null;

  constructor(args: { apiKey?: string } = {}) {
    this.apiKeyOverride = args.apiKey;
  }

  private getClient(): OpenRouter {
    if (!this.client) {
      const apiKey = this.apiKeyOverride ?? Env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error(
          'OpenRouter API key not provided (set OPENROUTER_API_KEY)'
        );
      }

      this.client = new OpenRouter({ apiKey });
    }

    return this.client;
  }

  async send(args: LlmSendArgs): Promise<LlmRawResponse> {
    const {
      model,
      messages,
      reasoningEffort,
      responseFormat,
      metadata,
      enableWebSearch,
    } = args;

    // Always stream — mirrors the Ollama plugin and lets us surface
    // deltas under `LLM_LOG_STREAM` without a parallel code path. Usage
    // is included in the final chunk by the OpenRouter API.
    const stream = await this.getClient().chat.send({
      chatRequest: {
        model,
        stream: true,
        responseFormat: {
          type: 'json_schema',
          jsonSchema: {
            name: responseFormat.name,
            strict: true,
            schema: responseFormat.schema,
          },
        },
        // Only route to providers that honor every parameter we sent — in
        // particular `responseFormat`. Without this, OpenRouter may route to
        // a provider whose deploy of the model rejects json_schema (e.g.
        // DeepInfra → stepfun-ai/Step-3.5-Flash returns HTTP 405).
        provider: { requireParameters: true },
        messages,
        // maxCompletionTokens: DEFAULT_MAX_COMPLETION_TOKENS,
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
        ...(metadata ? { metadata } : {}),
        // OpenRouter's server-side web-search plugin. When enabled, the model
        // gets a `web_search` tool it can call before answering. See:
        // https://openrouter.ai/docs/guides/features/server-tools/web-search
        ...(enableWebSearch ? { plugins: [{ id: 'web' as const }] } : {}),
      },
    });

    const logStream = Env.LLM_LOG_STREAM;
    if (logStream) {
      process.stdout.write(`\n--- LLM stream (${model}) ---\n`);
    }

    let content = '';
    let totalTokens = 0;
    for await (const chunk of stream) {
      if (chunk.error) {
        throw new Error(
          `OpenRouterPlugin: stream error ${chunk.error.code}: ${chunk.error.message}`
        );
      }

      const delta = chunk.choices[0]?.delta;
      if (delta?.reasoning && logStream) {
        process.stdout.write(delta.reasoning);
      }

      if (delta?.content) {
        if (logStream) process.stdout.write(delta.content);
        content += delta.content;
      }

      // OpenRouter only emits `usage` on the terminal chunk; the loop
      // ends naturally after it, so just overwrite as we go.
      const chunkTotalTokens = chunk.usage?.totalTokens;
      if (chunkTotalTokens) totalTokens = chunkTotalTokens;
    }

    if (logStream) {
      process.stdout.write('\n--- end stream ---\n');
    }

    return { content, totalTokens };
  }
}
