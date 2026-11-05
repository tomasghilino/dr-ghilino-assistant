import { EMBEDDING_DIMENSIONS } from "../config/env.ts";
import { OpenAiCompatibleEmbeddings } from "./openai-compatible.ts";
import type { EmbeddingProvider } from "./provider.ts";
import { VoyageEmbeddings } from "./voyage.ts";

/** The embeddings fields of the server and ingestion configs (see config/env.ts). */
export interface EmbeddingsConfig {
  EMBEDDINGS_PROVIDER: "voyage" | "openai-compatible";
  EMBEDDINGS_MODEL: string;
  EMBEDDINGS_TIMEOUT_MS: number;
  EMBEDDINGS_MAX_RETRIES: number;
  EMBEDDINGS_BATCH_SIZE: number;
  VOYAGE_API_KEY?: string | undefined;
  VOYAGE_BASE_URL: string;
  OPENAI_COMPATIBLE_BASE_URL?: string | undefined;
  OPENAI_COMPATIBLE_API_KEY?: string | undefined;
}

export function createEmbeddingProvider(
  config: EmbeddingsConfig,
  deps: { fetch?: typeof fetch } = {},
): EmbeddingProvider {
  const common = {
    model: config.EMBEDDINGS_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    timeoutMs: config.EMBEDDINGS_TIMEOUT_MS,
    maxRetries: config.EMBEDDINGS_MAX_RETRIES,
    batchSize: config.EMBEDDINGS_BATCH_SIZE,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  };
  if (config.EMBEDDINGS_PROVIDER === "voyage") {
    if (!config.VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY is required");
    return new VoyageEmbeddings({
      ...common,
      apiKey: config.VOYAGE_API_KEY,
      baseUrl: config.VOYAGE_BASE_URL,
    });
  }
  if (!config.OPENAI_COMPATIBLE_BASE_URL || !config.OPENAI_COMPATIBLE_API_KEY) {
    throw new Error("OPENAI_COMPATIBLE_BASE_URL and OPENAI_COMPATIBLE_API_KEY are required");
  }
  return new OpenAiCompatibleEmbeddings({
    ...common,
    apiKey: config.OPENAI_COMPATIBLE_API_KEY,
    baseUrl: config.OPENAI_COMPATIBLE_BASE_URL,
  });
}
