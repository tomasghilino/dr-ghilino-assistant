import { z } from "zod";
import { postJson } from "./http.ts";
import {
  assertVectors,
  type EmbeddingInputType,
  type EmbeddingProvider,
  type EmbeddingResult,
} from "./provider.ts";

export interface OpenAiCompatibleOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  /** e.g. https://api.openai.com/v1 */
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  batchSize: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const responseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number().int() })),
  usage: z.object({ total_tokens: z.number().int() }).optional(),
});

/**
 * Any `/embeddings` endpoint that follows OpenAI's contract. Kept so the provider can change by
 * configuration and the evaluation can compare models. These APIs have no query/document
 * distinction, so `inputType` is ignored; `dimensions` asks for 1024-d output to fit the column.
 */
export class OpenAiCompatibleEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly options: OpenAiCompatibleOptions;

  constructor(options: OpenAiCompatibleOptions) {
    this.options = options;
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  async embed(texts: readonly string[], _inputType: EmbeddingInputType): Promise<EmbeddingResult> {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let start = 0; start < texts.length; start += this.options.batchSize) {
      const batch = texts.slice(start, start + this.options.batchSize);
      const json = await postJson({
        fetch: this.options.fetch ?? fetch,
        url: `${this.options.baseUrl.replace(/\/$/, "")}/embeddings`,
        apiKey: this.options.apiKey,
        body: { input: batch, model: this.model, dimensions: this.dimensions },
        timeoutMs: this.options.timeoutMs,
        maxRetries: this.options.maxRetries,
        ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      });
      const parsed = responseSchema.parse(json);
      const ordered = [...parsed.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      assertVectors(ordered, batch.length, this.dimensions);
      vectors.push(...ordered);
      tokens += parsed.usage?.total_tokens ?? 0;
    }
    return { vectors, tokens };
  }
}
