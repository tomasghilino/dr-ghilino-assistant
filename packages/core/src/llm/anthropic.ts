import Anthropic from "@anthropic-ai/sdk";
import { AppError } from "../lib/errors.ts";
import type {
  LlmBlock,
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
} from "./types.ts";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high";
  timeoutMs: number;
  maxRetries: number;
  /** For tests: a fetch that never reaches the network. */
  fetch?: typeof fetch;
  baseURL?: string;
}

/**
 * Claude through the official SDK (ADR 0002). The only file that imports `@anthropic-ai/sdk`.
 *
 * - Adaptive thinking stays on (the default on Claude Haiku 5.5): with tools plus a JSON output
 *   format, thinking off makes the model skip tool calls it needs. `effort` is the cost lever.
 * - No temperature/top_p/top_k: Claude Haiku 5.5 rejects them.
 * - Thinking blocks come back as `opaque` and are replayed unchanged within the turn.
 * - Tools are `strict`, so their inputs always match the schema (the agent still validates).
 * - Tools and the stable system block are cached (`cache_control`); the date goes after it.
 */
export class AnthropicProvider implements LlmProvider {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly effort: AnthropicProviderOptions["effort"];

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.effort = options.effort;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: request.system.stable, cache_control: { type: "ephemeral" } },
    ];
    if (request.system.dynamic) system.push({ type: "text", text: request.system.dynamic });

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: request.maxTokens,
          system,
          messages: request.messages.map(toMessageParam),
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
            strict: true,
          })),
          thinking: { type: "adaptive" },
          output_config: {
            effort: this.effort,
            ...(request.outputSchema
              ? { format: { type: "json_schema", schema: request.outputSchema } }
              : {}),
          },
        },
        request.signal ? { signal: request.signal } : undefined,
      );
    } catch (error) {
      throw toAppError(error);
    }

    return {
      content: response.content.map(fromContentBlock),
      stopReason: mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
      model: response.model,
      refusalCategory:
        response.stop_reason === "refusal" ? (response.stop_details?.category ?? null) : null,
    };
  }
}

function toMessageParam(message: LlmMessage): Anthropic.MessageParam {
  return { role: message.role, content: message.content.map(toContentParam) };
}

function toContentParam(block: LlmBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_call":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content: block.content,
        is_error: block.isError,
      };
    case "opaque":
      if (block.provider !== "anthropic") {
        throw new Error(`cannot replay a ${block.provider} block to Anthropic`);
      }
      // A block this adapter produced from a response (thinking, redacted thinking), unchanged.
      return block.value as Anthropic.ContentBlockParam;
  }
}

function fromContentBlock(block: Anthropic.ContentBlock): LlmBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use") {
    return { type: "tool_call", id: block.id, name: block.name, input: block.input };
  }
  return { type: "opaque", provider: "anthropic", value: block };
}

function mapStopReason(reason: Anthropic.StopReason | null): LlmStopReason {
  switch (reason) {
    case "end_turn":
    case "tool_use":
    case "max_tokens":
    case "refusal":
      return reason;
    default:
      return "other";
  }
}

const UNAVAILABLE = "El asistente no está disponible en este momento.";

/** Typed SDK errors → categories. The upstream message never reaches visitors or logs. */
function toAppError(error: unknown): AppError {
  if (error instanceof Anthropic.APIUserAbortError) {
    return new AppError("timeout", UNAVAILABLE, { cause: error, retryable: true });
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new AppError("timeout", UNAVAILABLE, { cause: error, retryable: true });
  }
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  ) {
    return new AppError("configuration", UNAVAILABLE, {
      cause: error,
      internalMessage: `anthropic rejected the credentials (${error.status})`,
    });
  }
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError) {
    return new AppError("upstream_llm", UNAVAILABLE, {
      cause: error,
      retryable: true,
      internalMessage: `anthropic ${error.status}`,
    });
  }
  if (error instanceof Anthropic.APIError) {
    return new AppError("upstream_llm", UNAVAILABLE, {
      cause: error,
      retryable: (error.status ?? 0) >= 500,
      internalMessage: `anthropic ${error.status ?? "error"}`,
    });
  }
  return new AppError("upstream_llm", UNAVAILABLE, {
    cause: error,
    internalMessage: "anthropic call failed",
  });
}
