/**
 * Port for embedding models (ADR 0003). The rest of the system only knows this interface, so the
 * provider can change by configuration (Voyage today, an OpenAI-compatible API tomorrow).
 *
 * `inputType` matters for asymmetric models like Voyage: documents and queries are embedded
 * differently so that a question lands near the passage that answers it.
 */
export type EmbeddingInputType = "document" | "query";

export interface EmbeddingResult {
  /** One vector per input, in input order, each of length `dimensions`. */
  vectors: number[][];
  /** Tokens billed by the provider, for cost tracking. */
  tokens: number;
}

export interface EmbeddingProvider {
  /** Stored with every chunk; vectors from different models are never compared. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], inputType: EmbeddingInputType): Promise<EmbeddingResult>;
}

/** Shared checks for adapters: right count, right size, real numbers. */
export function assertVectors(
  vectors: number[][],
  expectedCount: number,
  dimensions: number,
): void {
  if (vectors.length !== expectedCount) {
    throw new Error(`expected ${expectedCount} embeddings, got ${vectors.length}`);
  }
  for (const vector of vectors) {
    if (vector.length !== dimensions) {
      throw new Error(`expected ${dimensions} dimensions, got ${vector.length}`);
    }
    if (!vector.every(Number.isFinite)) throw new Error("embedding contains a non-finite value");
  }
}
