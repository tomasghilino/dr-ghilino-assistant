import { describe, expect, it } from "vitest";
import { AppError } from "../lib/errors.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { estimateLlmCostUsd } from "./pricing.ts";
import type { LlmRequest } from "./types.ts";

function fakeAnthropic(responses: Array<{ status: number; body: unknown }>) {
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const next = responses[Math.min(call, responses.length - 1)] as {
      status: number;
      body: unknown;
    };
    call += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", "request-id": `req_${call}` },
    });
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

const REQUEST: LlmRequest = {
  system: { stable: "SYSTEM", dynamic: "Fecha: hoy" },
  messages: [{ role: "user", content: [{ type: "text", text: "¿Dónde atiende?" }] }],
  tools: [
    {
      name: "search_knowledge",
      description: "Search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
    },
  ],
  outputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  maxTokens: 2048,
};

const TOOL_USE_RESPONSE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [
    { type: "thinking", thinking: "", signature: "opaque-signature" },
    { type: "tool_use", id: "toolu_1", name: "search_knowledge", input: { query: "consultorios" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: {
    input_tokens: 1200,
    output_tokens: 80,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 0,
  },
};

describe("AnthropicProvider", () => {
  it("sends adaptive thinking, effort, strict tools, a cached system prompt and the JSON format", async () => {
    const { fetchImpl, bodies } = fakeAnthropic([{ status: 200, body: TOOL_USE_RESPONSE }]);
    const provider = new AnthropicProvider({
      apiKey: "sk-ant-test",
      model: "claude-haiku-5-5",
      effort: "low",
      timeoutMs: 5_000,
      maxRetries: 0,
      fetch: fetchImpl,
    });
    await provider.complete(REQUEST);
    const body = bodies[0] as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: { type: "json_schema" } },
      system: [
        { type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Fecha: hoy" },
      ],
      tools: [{ name: "search_knowledge", strict: true }],
    });
    // Claude Haiku 5.5 rejects sampling parameters.
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
  });

  it("maps blocks both ways and replays thinking unchanged", async () => {
    const { fetchImpl, bodies } = fakeAnthropic([{ status: 200, body: TOOL_USE_RESPONSE }]);
    const provider = new AnthropicProvider({
      apiKey: "sk-ant-test",
      model: "claude-haiku-5-5",
      effort: "low",
      timeoutMs: 5_000,
      maxRetries: 0,
      fetch: fetchImpl,
    });
    const first = await provider.complete(REQUEST);
    expect(first.stopReason).toBe("tool_use");
    expect(first.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
    expect(first.content[0]).toMatchObject({ type: "opaque", provider: "anthropic" });
    expect(first.content[1]).toEqual({
      type: "tool_call",
      id: "toolu_1",
      name: "search_knowledge",
      input: { query: "consultorios" },
    });

    await provider.complete({
      ...REQUEST,
      messages: [
        ...REQUEST.messages,
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [
            { type: "tool_result", toolCallId: "toolu_1", content: "<source…>", isError: false },
          ],
        },
      ],
    });
    const replayed = (bodies[1] as { messages: Array<{ content: unknown[] }> }).messages;
    expect(replayed[1]?.content[0]).toEqual({
      type: "thinking",
      thinking: "",
      signature: "opaque-signature",
    });
    expect(replayed[2]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "<source…>",
      is_error: false,
    });
  });

  it("reports refusals with their category", async () => {
    const { fetchImpl } = fakeAnthropic([
      {
        status: 200,
        body: {
          ...TOOL_USE_RESPONSE,
          content: [],
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "bio", explanation: null },
        },
      },
    ]);
    const provider = new AnthropicProvider({
      apiKey: "k",
      model: "claude-haiku-5-5",
      effort: "low",
      timeoutMs: 5_000,
      maxRetries: 0,
      fetch: fetchImpl,
    });
    const result = await provider.complete(REQUEST);
    expect(result.stopReason).toBe("refusal");
    expect(result.refusalCategory).toBe("bio");
  });

  it("turns API errors into categories without leaking the upstream message", async () => {
    const make = (status: number) =>
      new AnthropicProvider({
        apiKey: "k",
        model: "claude-haiku-5-5",
        effort: "low",
        timeoutMs: 5_000,
        maxRetries: 0,
        fetch: fakeAnthropic([
          {
            status,
            body: { type: "error", error: { type: "x", message: "secret upstream detail" } },
          },
        ]).fetchImpl,
      });
    const rateLimited = await make(429)
      .complete(REQUEST)
      .catch((error: unknown) => error);
    expect(rateLimited).toBeInstanceOf(AppError);
    expect(rateLimited).toMatchObject({ category: "upstream_llm", retryable: true });
    expect((rateLimited as AppError).publicMessage).not.toContain("secret");
    const unauthorized = await make(401)
      .complete(REQUEST)
      .catch((error: unknown) => error);
    expect(unauthorized).toMatchObject({ category: "configuration", retryable: false });
  });
});

describe("cost estimate", () => {
  it("prices input, output and cache tokens per model, and refuses to guess", () => {
    const usage = {
      inputTokens: 2_000,
      outputTokens: 200,
      cacheReadTokens: 3_000,
      cacheWriteTokens: 0,
    };
    // 2,000 × 0.10 + 200 × 0.50 + 3,000 × 0.01, per million.
    expect(estimateLlmCostUsd("claude-haiku-5-5", usage)).toBeCloseTo(0.00033, 8);
    expect(estimateLlmCostUsd("some-other-model", usage)).toBeNull();
  });
});
