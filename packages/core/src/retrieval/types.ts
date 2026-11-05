/** One row of `kb_hybrid_search` (see migrations/20261105214536_kb-hybrid-search.sql). */
export interface HybridSearchRow {
  chunk_id: string;
  source_id: string;
  document_title: string;
  anchor_url: string;
  heading_path: string[];
  content: string;
  content_hash: string;
  token_estimate: number;
  semantic_rank: number | null;
  semantic_similarity: number | null;
  lexical_rank: number | null;
  lexical_score: number | null;
  /** Share of the question's lexemes found in this chunk; null without a lexical match. */
  lexical_coverage: number | null;
  rrf_score: number;
  best_similarity: number | null;
  best_lexical_coverage: number | null;
}

/** A chunk the retrieval service hands to the agent. */
export interface RetrievedChunk {
  chunkId: string;
  sourceId: string;
  title: string;
  url: string;
  headingPath: string[];
  content: string;
  contentHash: string;
  tokens: number;
  semanticRank: number | null;
  similarity: number | null;
  lexicalRank: number | null;
  lexicalCoverage: number | null;
  rrfScore: number;
}

export interface RetrievalRequest {
  query: string;
  /** Defaults to RETRIEVAL_TOP_K. */
  topK?: number;
  /** Search only these sources (metadata filter). */
  sourceIds?: readonly string[];
}

/** Which signal let the question through the confidence gate. */
export type GatePass = "semantic" | "lexical" | "both" | "none";

export interface RetrievalResult {
  /**
   * False when neither signal passes the gate (see `gateDecision`). The agent must then abstain
   * (say the site does not cover it and offer the contact channels) instead of answering from
   * `chunks`, which are still returned for debugging and evaluation.
   */
  confident: boolean;
  gate: GatePass;
  bestSimilarity: number | null;
  bestLexicalCoverage: number | null;
  minSimilarity: number;
  chunks: RetrievedChunk[];
  /** Results dropped because a better-ranked result already says the same thing. */
  droppedNearDuplicates: number;
  usage: { embeddingTokens: number; cacheHit: boolean };
  timings: { embedMs: number; searchMs: number; totalMs: number };
}

export interface RetrievalSettings {
  topK: number;
  candidates: number;
  rrfK: number;
  minSimilarity: number;
  minLexicalCoverage: number;
  dedupeThreshold: number;
  cacheSize: number;
  cacheTtlMs: number;
}
