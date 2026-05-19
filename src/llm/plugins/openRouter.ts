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
    const { model, messages, reasoningEffort, responseFormat } = args;

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
        messages,
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
      },
    });

    const content = (response.choices[0]?.message?.content ?? '') as string;
    return { content, totalTokens: response.usage?.totalTokens ?? 0 };
  }
}
