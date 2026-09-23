/** JSON schemas stay neutral; validation belongs to the tool/structured layer. */
export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  jsonSchema: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  rawInput: unknown;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
}

export type ChatMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface Turn {
  text: string;
  toolCalls: ToolCall[];
  stopReason: 'end' | 'tool_calls' | 'max_tokens' | 'other';
  usage: Usage;
  latencyMs: number;
}

export interface Capabilities {
  streaming: boolean;
  strictTools: boolean;
  nativeStructuredOutput: boolean;
  thinking: boolean;
  promptCaching: boolean;
  forcedToolChoice: boolean;
}

/** Mirrors the LLM_MAX_TOKENS default for backends built without config. */
export const DEFAULT_MAX_TOKENS = 8192;

export interface CompleteRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  toolChoice?: 'auto' | { name: string };
  maxTokens: number;
  onText?: (delta: string) => void;
  /** Native output schema, mapped by each wire adapter (also used by the probe). */
  responseFormat?: { name: string; jsonSchema: JsonSchema };
  signal?: AbortSignal;
}
