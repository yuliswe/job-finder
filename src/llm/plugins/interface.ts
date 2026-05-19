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
};

export type LlmRawResponse = {
  content: string;
  totalTokens: number;
};

export type LlmPlugin = {
  send: (args: LlmSendArgs) => Promise<LlmRawResponse>;
};
