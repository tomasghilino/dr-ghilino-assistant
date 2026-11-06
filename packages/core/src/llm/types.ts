/**
 * Provider-neutral shapes for one model call (ADR 0002). The agent speaks only these; the
 * Anthropic adapter maps them to the SDK and back. Provider-only blocks (thinking, with their
 * signatures) travel as `opaque` values and are sent back unchanged inside a tool loop.
 */

export type JsonObjectSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

export type LlmBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolCallId: string; content: string; isError: boolean }
  | { type: "opaque"; provider: string; value: unknown };

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmBlock[];
}

export interface LlmToolDefinition {
  name: string;
  /** Says what the tool returns and when to call it: the model decides from this text. */
  description: string;
  inputSchema: JsonObjectSchema;
}

export interface LlmRequest {
  /**
   * `stable` never changes between requests and is cached by the provider (with the tools).
   * `dynamic` (today's date) comes after the cache breakpoint, so it does not invalidate it.
   */
  system: { stable: string; dynamic?: string };
  messages: LlmMessage[];
  tools: LlmToolDefinition[];
  /** JSON schema the final answer must follow (structured outputs). */
  outputSchema?: JsonObjectSchema;
  maxTokens: number;
  signal?: AbortSignal;
}

export type LlmStopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmResponse {
  content: LlmBlock[];
  stopReason: LlmStopReason;
  usage: LlmUsage;
  /** The model that actually answered, as reported by the provider. */
  model: string;
  /** Provider's refusal category when `stopReason` is "refusal". */
  refusalCategory?: string | null;
}

export interface LlmProvider {
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export const ZERO_USAGE: LlmUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}
