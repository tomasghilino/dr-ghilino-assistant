import type {
  LlmBlock,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStopReason,
} from "../../src/llm/types.ts";

/**
 * A stand-in for the model in tests: it returns the responses it was given, in order, and
 * records every request (deep-copied, because the agent keeps appending to its message list).
 * A step can be a function of the request, to answer with the source ids a tool returned.
 */
export type ScriptStep = LlmResponse | ((request: LlmRequest) => LlmResponse);

export class ScriptedLlm implements LlmProvider {
  readonly model = "scripted-model";
  readonly requests: LlmRequest[] = [];
  private index = 0;

  constructor(private readonly steps: ScriptStep[]) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const { signal: _signal, ...copy } = request;
    this.requests.push(structuredClone(copy));
    if (request.signal?.aborted) throw new Error("aborted");
    const step = this.steps[this.index];
    this.index += 1;
    if (!step) throw new Error(`ScriptedLlm ran out of steps at call ${this.index}`);
    return typeof step === "function" ? step(request) : step;
  }
}

const USAGE = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function toolUse(
  ...calls: Array<{ name: string; input?: unknown; id?: string }>
): LlmResponse {
  return response(
    [
      {
        type: "opaque",
        provider: "anthropic",
        value: { type: "thinking", thinking: "", signature: "sig" },
      },
      ...calls.map(
        (call, index): LlmBlock => ({
          type: "tool_call",
          id: call.id ?? `call_${index + 1}`,
          name: call.name,
          input: call.input ?? {},
        }),
      ),
    ],
    "tool_use",
  );
}

export function finalAnswer(answer: {
  answer: string;
  kind: string;
  source_ids?: string[];
  actions?: string[];
}): LlmResponse {
  return response(
    [
      {
        type: "text",
        text: JSON.stringify({ source_ids: [], actions: [], ...answer }),
      },
    ],
    "end_turn",
  );
}

export function response(content: LlmBlock[], stopReason: LlmStopReason): LlmResponse {
  return { content, stopReason, usage: USAGE, model: "scripted-model" };
}

/** Source ids the tools returned so far in this request (`<source id="S1" …>`). */
export function sourceIdsIn(request: LlmRequest): string[] {
  const ids: string[] = [];
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      for (const match of block.content.matchAll(/<source id="(S\d+)"/g))
        ids.push(match[1] as string);
    }
  }
  return ids;
}

/** Text of every tool result in the request, joined. */
export function toolResultsIn(request: LlmRequest): string {
  return request.messages
    .flatMap((message) => message.content)
    .filter(
      (block): block is Extract<LlmBlock, { type: "tool_result" }> => block.type === "tool_result",
    )
    .map((block) => block.content)
    .join("\n");
}
