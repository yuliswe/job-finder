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
    const { model, messages, reasoningEffort, responseFormat, metadata } = args;

    const response = await this.getClient().chat.send({
      chatRequest: {
        model,
        stream: false,
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
      },
    });

    const content = (response.choices[0]?.message?.content ?? '') as string;
    return { content, totalTokens: response.usage?.totalTokens ?? 0 };
  }
}
