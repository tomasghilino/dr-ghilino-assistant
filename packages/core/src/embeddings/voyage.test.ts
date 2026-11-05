import { describe, expect, it } from "vitest";
import { AppError } from "../lib/errors.ts";
import { OpenAiCompatibleEmbeddings } from "./openai-compatible.ts";
import { VoyageEmbeddings } from "./voyage.ts";

const DIMS = 4;
const vector = (seed: number) => [seed, 0, 0, 0];

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { input: string[]; model: string; input_type?: string; output_dimension?: number };
}

/** Scripted fetch: each call takes the next response (or throws the next error). */
function scripted(responses: Array<Response | Error | ((call: Call) => Response)>) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: input.toString(),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next;
  }) as typeof fetch;
  return { impl, calls };
}

const ok = (call: Call) =>
  Response.json({
    // Returned out of order on purpose: the adapter must sort by index.
    data: call.body.input.map((_, index) => ({ embedding: vector(index + 1), index })).reverse(),
    usage: { total_tokens: call.body.input.length * 3 },
  });

function voyage(
  fetch: typeof globalThis.fetch,
  overrides: Partial<ConstructorParameters<typeof VoyageEmbeddings>[0]> = {},
) {
  return new VoyageEmbeddings({
    apiKey: "pa-test",
    model: "voyage-4",
    dimensions: DIMS,
    baseUrl: "https://ai.mongodb.com/v1/",
    timeoutMs: 1_000,
    maxRetries: 2,
    batchSize: 2,
    fetch,
    sleep: async () => {},
    ...overrides,
  });
}

describe("VoyageEmbeddings", () => {
  it("sends the documented request and returns vectors in input order", async () => {
    const { impl, calls } = scripted([ok]);
    const result = await voyage(impl).embed(["a", "b"], "query");
    expect(calls[0]?.url).toBe("https://ai.mongodb.com/v1/embeddings");
    expect(calls[0]?.headers.Authorization).toBe("Bearer pa-test");
    expect(calls[0]?.body).toEqual({
      input: ["a", "b"],
      model: "voyage-4",
      input_type: "query",
      output_dimension: DIMS,
    });
    expect(result).toEqual({ vectors: [vector(1), vector(2)], tokens: 6 });
  });

  it("batches long inputs and adds up the tokens", async () => {
    const { impl, calls } = scripted([ok, ok, ok]);
    const result = await voyage(impl).embed(["a", "b", "c", "d", "e"], "document");
    expect(calls.map((call) => call.body.input)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(result.vectors).toHaveLength(5);
    expect(result.tokens).toBe(15);
  });

  it("retries rate limits and network errors, then succeeds", async () => {
    const waits: number[] = [];
    const { impl, calls } = scripted([
      new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      new TypeError("fetch failed"),
      ok,
    ]);
    const result = await voyage(impl, { sleep: async (ms) => void waits.push(ms) }).embed(
      ["a"],
      "query",
    );
    expect(calls).toHaveLength(3);
    expect(waits[0]).toBe(2_000); // honours Retry-After
    expect(result.vectors).toEqual([vector(1)]);
  });

  it("fails fast on a client error and never echoes the provider's body", async () => {
    const { impl } = scripted([
      new Response("the input 'mi DNI es 12345678' is invalid", { status: 400 }),
    ]);
    const error = await voyage(impl)
      .embed(["mi DNI es 12345678"], "query")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).category).toBe("upstream_embeddings");
    expect((error as AppError).message).toBe("embeddings provider returned HTTP 400");
    expect(JSON.stringify(error)).not.toContain("12345678");
  });

  it("gives up after the configured retries", async () => {
    const { impl, calls } = scripted([
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    ]);
    await expect(voyage(impl).embed(["a"], "query")).rejects.toMatchObject({ retryable: true });
    expect(calls).toHaveLength(3);
  });

  it("rejects vectors of the wrong size", async () => {
    const { impl } = scripted([Response.json({ data: [{ embedding: [1, 2], index: 0 }] })]);
    await expect(voyage(impl).embed(["a"], "query")).rejects.toThrow(/expected 4 dimensions/);
  });
});

describe("OpenAiCompatibleEmbeddings", () => {
  it("asks for the configured dimensions and has no input type", async () => {
    const { impl, calls } = scripted([ok]);
    const provider = new OpenAiCompatibleEmbeddings({
      apiKey: "k",
      model: "openai/text-embedding-3-small",
      dimensions: DIMS,
      baseUrl: "https://example.com/v1",
      timeoutMs: 1_000,
      maxRetries: 0,
      batchSize: 10,
      fetch: impl,
    });
    await provider.embed(["a"], "query");
    expect(calls[0]?.body).toEqual({
      input: ["a"],
      model: "openai/text-embedding-3-small",
      dimensions: DIMS,
    });
  });
});
