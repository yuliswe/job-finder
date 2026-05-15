export type LlmRole = 'system' | 'user' | 'assistant';

export type LlmMessage = {
  role: LlmRole;
  content: string;
};

export type LlmReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh';

export type LlmResponseFormat = {
  name: string;
  schema: Record<string, unknown>;
};

export type LlmSendArgs = {
  model: string;
  messages: LlmMessage[];
  reasoningEffort?: LlmReasoningEffort;
  responseFormat: LlmResponseFormat;
};

export type LlmRawResponse = {
  content: string;
  totalTokens: number;
};

export type LlmPlugin = {
  send: (args: LlmSendArgs) => Promise<LlmRawResponse>;
};
