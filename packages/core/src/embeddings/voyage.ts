import { z } from "zod";
import { postJson } from "./http.ts";
import {
  assertVectors,
  type EmbeddingInputType,
  type EmbeddingProvider,
  type EmbeddingResult,
} from "./provider.ts";

export interface VoyageOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  /** https://ai.mongodb.com/v1 for keys created in MongoDB Atlas (the current Voyage platform). */
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
 * Voyage AI embeddings through MongoDB Atlas's Embedding API (ADR 0003), called over REST with
 * `fetch`. The official `voyageai` npm client defaults to the legacy api.voyageai.com host, adds
 * dependencies to the Deno function, and hides retries we want to control; the REST contract is
 * four fields, documented at https://www.mongodb.com/docs/voyageai/api-and-clients/.
 */
export class VoyageEmbeddings implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly options: VoyageOptions;

  constructor(options: VoyageOptions) {
    this.options = options;
    this.model = options.model;
    this.dimensions = options.dimensions;
  }

  async embed(texts: readonly string[], inputType: EmbeddingInputType): Promise<EmbeddingResult> {
    const vectors: number[][] = [];
    let tokens = 0;
    for (let start = 0; start < texts.length; start += this.options.batchSize) {
      const batch = texts.slice(start, start + this.options.batchSize);
      const json = await postJson({
        fetch: this.options.fetch ?? fetch,
        url: `${this.options.baseUrl.replace(/\/$/, "")}/embeddings`,
        apiKey: this.options.apiKey,
        body: {
          input: batch,
          model: this.model,
          input_type: inputType,
          output_dimension: this.dimensions,
        },
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
