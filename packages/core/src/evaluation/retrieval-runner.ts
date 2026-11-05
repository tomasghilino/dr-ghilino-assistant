import type { RetrievalService } from "../retrieval/service.ts";
import type { GatePass, HybridSearchRow, RetrievalSettings } from "../retrieval/types.ts";
import {
  chunkKey,
  type RetrievalCaseCategory,
  type RetrievalEvalFile,
  resolveGroups,
} from "./retrieval-dataset.ts";
import {
  type AggregateScore,
  aggregateScores,
  type GateItem,
  type GateStats,
  gateStats,
  percentile,
  type RankingScore,
  recommendThreshold,
  scoreRanking,
  sweepThresholds,
  type ThresholdRecommendation,
} from "./retrieval-metrics.ts";

/**
 * The four rankings compared for every question:
 * - semantic: pgvector cosine order only
 * - lexical: Spanish full-text order only
 * - hybrid: both fused with RRF, as the database returns them
 * - service: what the agent will get (hybrid, then near-duplicates dropped, cut to top K)
 */
export const RANKING_MODES = ["semantic", "lexical", "hybrid", "service"] as const;
export type RankingMode = (typeof RANKING_MODES)[number];

export interface RetrievalEvalOptions {
  ks: readonly number[];
  mrrCutoff: number;
  thresholds: readonly number[];
  settings: RetrievalSettings;
  now?: () => Date;
}

export interface RetrievalEvalCaseResult {
  id: string;
  category: RetrievalCaseCategory;
  expect: "answer" | "abstain" | "any";
  query: string;
  scored: boolean;
  bestSimilarity: number | null;
  bestLexicalCoverage: number | null;
  confident: boolean;
  gate: GatePass;
  firstRelevantRank: Record<RankingMode, number | null>;
  recallAtMaxK: Record<RankingMode, number>;
  /** Chunk keys (heading paths) of the top results, never their content. */
  top: Record<RankingMode, string[]>;
}

export interface RetrievalEvalReport {
  generatedAt: string;
  embeddingModel: string;
  settings: RetrievalSettings;
  ks: readonly number[];
  mrrCutoff: number;
  dataset: { cases: number; scoredCases: number; byCategory: Record<string, number> };
  metrics: Record<RankingMode, AggregateScore>;
  byCategory: Record<string, Record<RankingMode, AggregateScore>>;
  /**
   * The confidence gate measured twice: with the semantic signal alone, and with the lexical way
   * through as configured (RETRIEVAL_MIN_LEXICAL_COVERAGE). Same sweep, same policy.
   */
  gate: Record<
    "semanticOnly" | "semanticOrLexical",
    { current: GateStats; sweep: GateStats[]; recommended: ThresholdRecommendation | null }
  > & {
    /** Both signals of every gated case, highest similarity first. */
    signals: Array<GateItem & { id: string }>;
  };
  latencyMs: { search: { p50: number; p95: number }; service: { p50: number; p95: number } };
  usage: { embeddingTokens: number; queriesEmbedded: number; serviceCacheMisses: number };
  /** Aliases that never showed up in any ranking (a typo in the dataset or a missing chunk). */
  unseenAliases: string[];
  cases: RetrievalEvalCaseResult[];
}

export async function runRetrievalEval(
  service: RetrievalService,
  file: RetrievalEvalFile,
  options: RetrievalEvalOptions,
): Promise<RetrievalEvalReport> {
  const { ks, mrrCutoff, settings } = options;
  const maxK = Math.max(...ks);
  // One embeddings call for the whole dataset; every search below hits the cache.
  const embedded = await service.embedQueries(file.cases.map((item) => item.query));

  const scores: Record<RankingMode, RankingScore[]> = {
    semantic: [],
    lexical: [],
    hybrid: [],
    service: [],
  };
  const categoryScores = new Map<string, Record<RankingMode, RankingScore[]>>();
  const seenKeys = new Set<string>();
  const searchMs: number[] = [];
  const serviceMs: number[] = [];
  let serviceCacheMisses = 0;
  const cases: RetrievalEvalCaseResult[] = [];

  for (const [index, item] of file.cases.entries()) {
    const vector = embedded.vectors[index] as number[];
    const started = performance.now();
    const rows = await service.searchByVector(vector, item.query, {
      matchCount: settings.candidates * 2,
      candidates: settings.candidates,
    });
    searchMs.push(performance.now() - started);
    const result = await service.search({ query: item.query });
    serviceMs.push(result.timings.totalMs);
    if (!result.usage.cacheHit) serviceCacheMisses += 1;

    const rankings: Record<RankingMode, string[]> = {
      semantic: byRank(rows, "semantic_rank"),
      lexical: byRank(rows, "lexical_rank"),
      hybrid: rows.map((row) => chunkKey(row.heading_path)),
      service: result.chunks.map((chunk) => chunkKey(chunk.headingPath)),
    };
    for (const key of rankings.hybrid) seenKeys.add(key);

    const groups = resolveGroups(file, item);
    const scored = groups.length > 0;
    const caseScores = Object.fromEntries(
      RANKING_MODES.map((mode) => [mode, scoreRanking(rankings[mode], groups, ks, mrrCutoff)]),
    ) as Record<RankingMode, RankingScore>;
    if (scored) {
      let perCategory = categoryScores.get(item.category);
      if (!perCategory) {
        perCategory = { semantic: [], lexical: [], hybrid: [], service: [] };
        categoryScores.set(item.category, perCategory);
      }
      for (const mode of RANKING_MODES) {
        scores[mode].push(caseScores[mode]);
        perCategory[mode].push(caseScores[mode]);
      }
    }

    cases.push({
      id: item.id,
      category: item.category,
      expect: item.expect,
      query: item.query,
      scored,
      bestSimilarity: result.bestSimilarity,
      bestLexicalCoverage: result.bestLexicalCoverage,
      confident: result.confident,
      gate: result.gate,
      firstRelevantRank: mapModes((mode) => (scored ? caseScores[mode].firstRelevantRank : null)),
      recallAtMaxK: mapModes((mode) => (scored ? (caseScores[mode].recallAt[maxK] ?? 0) : 0)),
      top: mapModes((mode) => rankings[mode].slice(0, maxK)),
    });
  }

  const gated = cases.flatMap((item) =>
    item.expect === "any"
      ? []
      : [
          {
            id: item.id,
            expect: item.expect,
            bestSimilarity: item.bestSimilarity,
            bestLexicalCoverage: item.bestLexicalCoverage,
          },
        ],
  );
  const measureGate = (minLexicalCoverage: number | null) => {
    const sweep = sweepThresholds(gated, options.thresholds, minLexicalCoverage);
    return {
      current: gateStats(gated, settings.minSimilarity, minLexicalCoverage),
      sweep,
      recommended: recommendThreshold(sweep),
    };
  };
  const byCategoryCount: Record<string, number> = {};
  for (const item of file.cases)
    byCategoryCount[item.category] = (byCategoryCount[item.category] ?? 0) + 1;

  return {
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    embeddingModel: service.embeddingModel,
    settings,
    ks,
    mrrCutoff,
    dataset: {
      cases: file.cases.length,
      scoredCases: scores.hybrid.length,
      byCategory: byCategoryCount,
    },
    metrics: mapModes((mode) => aggregateScores(scores[mode], ks)),
    byCategory: Object.fromEntries(
      [...categoryScores].map(([category, perMode]) => [
        category,
        mapModes((mode) => aggregateScores(perMode[mode], ks)),
      ]),
    ),
    gate: {
      semanticOnly: measureGate(null),
      semanticOrLexical: measureGate(settings.minLexicalCoverage),
      signals: [...gated].sort((a, b) => (b.bestSimilarity ?? -1) - (a.bestSimilarity ?? -1)),
    },
    latencyMs: {
      search: { p50: percentile(searchMs, 50), p95: percentile(searchMs, 95) },
      service: { p50: percentile(serviceMs, 50), p95: percentile(serviceMs, 95) },
    },
    usage: {
      embeddingTokens: embedded.tokens,
      queriesEmbedded: file.cases.length - embedded.cacheHits,
      serviceCacheMisses,
    },
    unseenAliases: Object.entries(file.aliases)
      .filter(([, key]) => !seenKeys.has(key))
      .map(([alias]) => alias),
    cases,
  };
}

function byRank(rows: readonly HybridSearchRow[], field: "semantic_rank" | "lexical_rank") {
  return rows
    .filter((row) => row[field] !== null)
    .sort((a, b) => (a[field] as number) - (b[field] as number))
    .map((row) => chunkKey(row.heading_path));
}

function mapModes<T>(fn: (mode: RankingMode) => T): Record<RankingMode, T> {
  return Object.fromEntries(RANKING_MODES.map((mode) => [mode, fn(mode)])) as Record<
    RankingMode,
    T
  >;
}

/** Thresholds from `from` to `to` (inclusive) in `step` increments, rounded to avoid 0.35000001. */
export function thresholdRange(from: number, to: number, step: number): number[] {
  const values: number[] = [];
  for (let value = from; value <= to + step / 2; value += step)
    values.push(Math.round(value * 1000) / 1000);
  return values;
}
