import type { RetrievalConfig } from "../config/env.ts";
import { type RpcClient, toVectorLiteral } from "../db/rpc.ts";
import type { EmbeddingProvider } from "../embeddings/provider.ts";
import { LruCache } from "../lib/cache.ts";
import { sha256Hex } from "../lib/hash.ts";
import { bodyShingles, containment } from "../lib/shingles.ts";
import { foldForSearch, normalizeWhitespace } from "../lib/text.ts";
import type {
  GatePass,
  HybridSearchRow,
  RetrievalRequest,
  RetrievalResult,
  RetrievalSettings,
  RetrievedChunk,
} from "./types.ts";

export function retrievalSettingsFrom(config: RetrievalConfig): RetrievalSettings {
  return {
    topK: config.RETRIEVAL_TOP_K,
    candidates: config.RETRIEVAL_CANDIDATES,
    rrfK: config.RETRIEVAL_RRF_K,
    minSimilarity: config.RETRIEVAL_MIN_SIMILARITY,
    minLexicalCoverage: config.RETRIEVAL_MIN_LEXICAL_COVERAGE,
    dedupeThreshold: config.RETRIEVAL_DEDUPE_THRESHOLD,
    cacheSize: config.RETRIEVAL_QUERY_CACHE_SIZE,
    cacheTtlMs: config.RETRIEVAL_QUERY_CACHE_TTL_MS,
  };
}

export interface RawSearchOptions {
  matchCount: number;
  candidates: number;
  sourceIds?: readonly string[] | undefined;
}

/**
 * Retrieval (ADR 0004, ADR 0011): question → query embedding → hybrid search in Postgres →
 * confidence gate → near-duplicate filter. Knows nothing about the LLM; the agent's
 * `search_knowledge` tool (Phase 4) is a thin wrapper around `search`.
 */
export class RetrievalService {
  private readonly cache: LruCache<number[]>;

  constructor(
    private readonly deps: { rpc: RpcClient; embeddings: EmbeddingProvider },
    private readonly settings: RetrievalSettings,
  ) {
    this.cache = new LruCache(settings.cacheSize, settings.cacheTtlMs);
  }

  get embeddingModel(): string {
    return this.deps.embeddings.model;
  }

  /**
   * Embed questions with `input_type: "query"`, reusing cached vectors. Uncached questions go to
   * the provider in one call (the provider splits it into batches). The cache key is a hash, so
   * visitors' questions are not kept as text in memory.
   */
  async embedQueries(
    queries: readonly string[],
  ): Promise<{ vectors: number[][]; tokens: number; cacheHits: number }> {
    const texts = queries.map((query) => normalizeWhitespace(query));
    const keys = await Promise.all(
      texts.map((text) => sha256Hex(`${this.deps.embeddings.model}\n${text}`)),
    );
    const vectors: Array<number[] | undefined> = keys.map((key) => this.cache.get(key));
    const missing = [...new Set(texts.filter((_, index) => vectors[index] === undefined))];
    let tokens = 0;
    if (missing.length > 0) {
      const result = await this.deps.embeddings.embed(missing, "query");
      tokens = result.tokens;
      const byText = new Map(missing.map((text, index) => [text, result.vectors[index]]));
      texts.forEach((text, index) => {
        if (vectors[index] !== undefined) return;
        const vector = byText.get(text);
        if (!vector) throw new Error("embedding provider returned fewer vectors than inputs");
        vectors[index] = vector;
        this.cache.set(keys[index] as string, vector);
      });
    }
    return {
      vectors: vectors as number[][],
      tokens,
      cacheHits: queries.length - missing.length,
    };
  }

  /** The database ranking as is: no gate, no deduplication. For debugging and evaluation. */
  searchByVector(
    vector: readonly number[],
    query: string,
    options: RawSearchOptions,
  ): Promise<HybridSearchRow[]> {
    return this.deps.rpc.rows<HybridSearchRow>("kb_hybrid_search", {
      p_query_embedding: toVectorLiteral(vector),
      // The lexical index is built from accent-folded text, so the query is folded the same way.
      p_query_text: foldForSearch(query),
      p_embedding_model: this.deps.embeddings.model,
      p_match_count: options.matchCount,
      p_candidates: options.candidates,
      p_rrf_k: this.settings.rrfK,
      p_source_ids: options.sourceIds ? [...options.sourceIds] : null,
    });
  }

  async search(request: RetrievalRequest): Promise<RetrievalResult> {
    const started = performance.now();
    const topK = request.topK ?? this.settings.topK;
    const empty = (embedMs = 0): RetrievalResult => ({
      confident: false,
      gate: "none",
      bestSimilarity: null,
      bestLexicalCoverage: null,
      minSimilarity: this.settings.minSimilarity,
      chunks: [],
      droppedNearDuplicates: 0,
      usage: { embeddingTokens: 0, cacheHit: false },
      timings: { embedMs, searchMs: 0, totalMs: performance.now() - started },
    });
    if (normalizeWhitespace(request.query) === "") return empty();

    const embedded = await this.embedQueries([request.query]);
    const embedMs = performance.now() - started;
    const rows = await this.searchByVector(embedded.vectors[0] as number[], request.query, {
      // Ask for a few extra rows so that dropping near-duplicates still leaves topK results.
      matchCount: Math.min(topK * 2, this.settings.candidates * 2),
      candidates: this.settings.candidates,
      sourceIds: request.sourceIds,
    });
    const searchMs = performance.now() - started - embedMs;

    const { kept, dropped } = dropNearDuplicates(rows, this.settings.dedupeThreshold);
    const bestSimilarity = rows[0]?.best_similarity ?? null;
    const bestLexicalCoverage = rows[0]?.best_lexical_coverage ?? null;
    const gate = gateDecision(bestSimilarity, bestLexicalCoverage, this.settings);
    return {
      confident: gate !== "none",
      gate,
      bestSimilarity,
      bestLexicalCoverage,
      minSimilarity: this.settings.minSimilarity,
      chunks: kept.slice(0, topK).map(toRetrievedChunk),
      droppedNearDuplicates: dropped,
      usage: { embeddingTokens: embedded.tokens, cacheHit: embedded.cacheHits === 1 },
      timings: { embedMs, searchMs, totalMs: performance.now() - started },
    };
  }
}

/**
 * The confidence gate (ADR 0011). Two independent ways through:
 * - semantic: the closest chunk is similar enough in meaning (cosine ≥ minSimilarity);
 * - lexical: one chunk contains (nearly) every term of the question (coverage ≥ minLexicalCoverage).
 * Similarity measures how close a question is to a topic, not whether the site answers it, so the
 * gate filters what is clearly off-topic; the agent still has to check that the sources answer.
 */
export function gateDecision(
  bestSimilarity: number | null,
  bestLexicalCoverage: number | null,
  settings: Pick<RetrievalSettings, "minSimilarity" | "minLexicalCoverage">,
): GatePass {
  const semantic = bestSimilarity !== null && bestSimilarity >= settings.minSimilarity;
  const lexical =
    bestLexicalCoverage !== null && bestLexicalCoverage >= settings.minLexicalCoverage;
  if (semantic && lexical) return "both";
  if (semantic) return "semantic";
  if (lexical) return "lexical";
  return "none";
}

/**
 * Neighbouring chunks of one section overlap by design (CHUNK_OVERLAP_TOKENS), and two sources
 * can say the same thing. Sending both to the model costs tokens and adds nothing, so a result
 * mostly contained in a single better-ranked result is dropped.
 */
export function dropNearDuplicates(
  rows: readonly HybridSearchRow[],
  threshold: number,
): { kept: HybridSearchRow[]; dropped: number } {
  const kept: HybridSearchRow[] = [];
  const keptShingles: Array<Set<string>> = [];
  const hashes = new Set<string>();
  let dropped = 0;
  for (const row of rows) {
    const shingles = bodyShingles(row.content);
    const duplicate =
      hashes.has(row.content_hash) ||
      (shingles.size > 0 &&
        keptShingles.some((better) => containment(shingles, better) >= threshold));
    if (duplicate) {
      dropped += 1;
      continue;
    }
    hashes.add(row.content_hash);
    kept.push(row);
    keptShingles.push(shingles);
  }
  return { kept, dropped };
}

function toRetrievedChunk(row: HybridSearchRow): RetrievedChunk {
  return {
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    title: row.document_title,
    url: row.anchor_url,
    headingPath: row.heading_path,
    content: row.content,
    contentHash: row.content_hash,
    tokens: row.token_estimate,
    semanticRank: row.semantic_rank,
    similarity: row.semantic_similarity,
    lexicalRank: row.lexical_rank,
    lexicalCoverage: row.lexical_coverage,
    rrfScore: row.rrf_score,
  };
}
