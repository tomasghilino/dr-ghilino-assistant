import type {
  EmbeddingInputType,
  EmbeddingProvider,
  EmbeddingResult,
} from "../../src/embeddings/provider.ts";
import { foldForSearch } from "../../src/lib/text.ts";

/**
 * Deterministic, offline stand-in for an embedding model, for tests only.
 *
 * "Feature hashing": every accent-folded word adds ±1 to one of 1024 slots chosen by its hash, and
 * the vector is normalised to length 1. Texts that share words get a positive cosine similarity,
 * so retrieval tests can rank sensibly without a network call or an API key. It knows nothing
 * about meaning ("cuánto sale" and "valor" share no slot); real semantic behaviour is measured
 * with the real model in the evaluation.
 */
export class HashingEmbeddings implements EmbeddingProvider {
  readonly model = "test-hashing-v1";
  readonly dimensions = 1024;
  calls: Array<{ texts: readonly string[]; inputType: EmbeddingInputType }> = [];

  async embed(texts: readonly string[], inputType: EmbeddingInputType): Promise<EmbeddingResult> {
    this.calls.push({ texts, inputType });
    return {
      vectors: texts.map((text) => this.vector(text)),
      tokens: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
    };
  }

  vector(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    for (const word of foldForSearch(text).match(/[\p{L}\p{N}]+/gu) ?? []) {
      const h = fnv1a(word);
      const slot = h % this.dimensions;
      vector[slot] = (vector[slot] ?? 0) + ((h >>> 16) & 1 ? 1 : -1);
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  }
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
