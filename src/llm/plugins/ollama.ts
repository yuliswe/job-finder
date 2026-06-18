import type { LlmRawResponse, LlmSendArgs } from 'src/llm/plugins/interface.js';
import { Env } from 'src/utils/env.js';
import { fetchWithTimeout } from 'src/utils/fetchWithTimeout.js';

/** Talks to a locally-running Ollama daemon (https://ollama.com) — same
 * `chat` shape as OpenAI, but with structured output via the `format`
 * field (a literal JSON Schema object, supported since Ollama v0.5).
 *
 * Selected globally by setting `LLM_PLUGIN = 'ollama'` in
 * `jobfinder.config.js`. Model strings then become bare Ollama tags
 * (e.g. `LLM_VIEWING_MODEL = 'llama3.1'`).
 *
 * Unsupported features (currently):
 *   - `enableWebSearch` — Ollama has no native web-search tool. Throws.
 *   - `reasoningEffort` — Ollama doesn't expose effort knobs. Silently
 *      ignored; reasoning behavior is whatever the underlying model
 *      does by default.
 *   - `metadata` — no analytics surface; ignored. */
export class OllamaPlugin {
  private readonly hostOverride: string | undefined;

  constructor(args: { host?: string } = {}) {
    this.hostOverride = args.host;
  }

  async send(args: LlmSendArgs): Promise<LlmRawResponse> {
    if (args.enableWebSearch) {
      throw new Error(
        'OllamaPlugin: enableWebSearch is not supported. Use OpenRouterPlugin for web-search-augmented calls.'
      );
    }

    const host = (this.hostOverride ?? Env.OLLAMA_HOST).replace(/\/+$/, '');
    const url = `${host}/api/chat`;

    const body = {
      model: args.model,
      messages: args.messages,
      stream: true,
      // Ollama's structured-output knob: pass the JSON Schema literally.
      // (Older Ollama versions accepted only the string "json"; v0.5+
      // accepts a full schema object and constrains the model to it.)
      format: args.responseFormat.schema,
    };

    // Local Ollama is fast on small models but a cold-start on a 70B
    // model can take a minute; cap at 10 min.
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 10 * 60_000,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `OllamaPlugin: ${url} returned HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`
      );
    }

    if (!response.body) {
      throw new Error(`OllamaPlugin: ${url} returned no response body`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let promptEvalCount = 0;
    let evalCount = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
          error?: string;
        };

        if (chunk.error) {
          throw new Error(`OllamaPlugin: ${chunk.error}`);
        }

        if (chunk.message?.content) content += chunk.message.content;
        if (chunk.done) {
          promptEvalCount = chunk.prompt_eval_count ?? 0;
          evalCount = chunk.eval_count ?? 0;
        }
      }
    }

    const trailing = buffer.trim();
    if (trailing) {
      const chunk = JSON.parse(trailing) as {
        message?: { content?: string };
        done?: boolean;
        prompt_eval_count?: number;
        eval_count?: number;
        error?: string;
      };

      if (chunk.error) {
        throw new Error(`OllamaPlugin: ${chunk.error}`);
      }

      if (chunk.message?.content) content += chunk.message.content;
      if (chunk.done) {
        promptEvalCount = chunk.prompt_eval_count ?? 0;
        evalCount = chunk.eval_count ?? 0;
      }
    }

    return { content, totalTokens: promptEvalCount + evalCount };
  }
}
