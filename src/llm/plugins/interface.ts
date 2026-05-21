export type LlmRole = 'system' | 'user' | 'assistant';

export type LlmMessage = {
  role: LlmRole;
  content: string;
};

export const LlmReasoningEffort = {
  Minimal: 'minimal',
  Low: 'low',
  Medium: 'medium',
  High: 'high',
  XHigh: 'xhigh',
} as const;

export type LlmReasoningEffort =
  (typeof LlmReasoningEffort)[keyof typeof LlmReasoningEffort];

export type LlmResponseFormat = {
  name: string;
  schema: Record<string, unknown>;
};

export type LlmSendArgs = {
  model: string;
  messages: LlmMessage[];
  reasoningEffort?: LlmReasoningEffort;
  responseFormat: LlmResponseFormat;
  /** Free-form tags persisted on the request for cost / observability
   * analytics. Forwarded verbatim to OpenRouter's `metadata` field. */
  metadata?: Record<string, string>;
  /** Enable the provider's native web-search capability for this request.
   * On OpenRouter this attaches `plugins: [{ id: 'web' }]`. Plugins whose
   * underlying provider doesn't expose a web-search tool should throw. */
  enableWebSearch?: boolean;
};

export type LlmRawResponse = {
  content: string;
  totalTokens: number;
};

export type LlmPlugin = {
  send: (args: LlmSendArgs) => Promise<LlmRawResponse>;
};
