import type { GateExpectation } from "./retrieval-dataset.ts";

/**
 * Retrieval metrics (docs/evaluation.md). All of them compare a ranked list of chunk keys with the
 * requirement groups of a case.
 *
 * - Hit@K: at least one relevant chunk is in the top K.
 * - Recall@K: share of requirement groups with at least one chunk in the top K. A question that
 *   needs the fee *and* the booking channel scores 0.5 when only the fee is found.
 * - Reciprocal rank: 1 / position of the first relevant chunk, 0 if none in the cutoff. Its mean
 *   over cases is MRR: 1 means the right chunk is always first, 0.5 means usually second.
 */
export interface RankingScore {
  hitAt: Record<number, boolean>;
  recallAt: Record<number, number>;
  reciprocalRank: number;
  firstRelevantRank: number | null;
}

export function scoreRanking(
  rankedKeys: readonly string[],
  groups: readonly (readonly string[])[],
  ks: readonly number[],
  mrrCutoff: number,
): RankingScore {
  const relevant = new Set(groups.flat());
  const firstIndex = rankedKeys.findIndex((key) => relevant.has(key));
  const firstRelevantRank = firstIndex === -1 ? null : firstIndex + 1;
  const hitAt: Record<number, boolean> = {};
  const recallAt: Record<number, number> = {};
  for (const k of ks) {
    const top = new Set(rankedKeys.slice(0, k));
    hitAt[k] = firstRelevantRank !== null && firstRelevantRank <= k;
    recallAt[k] =
      groups.length === 0
        ? 0
        : groups.filter((group) => group.some((key) => top.has(key))).length / groups.length;
  }
  return {
    hitAt,
    recallAt,
    reciprocalRank:
      firstRelevantRank !== null && firstRelevantRank <= mrrCutoff ? 1 / firstRelevantRank : 0,
    firstRelevantRank,
  };
}

export interface AggregateScore {
  cases: number;
  hitAt: Record<number, number>;
  recallAt: Record<number, number>;
  mrr: number;
}

export function aggregateScores(
  scores: readonly RankingScore[],
  ks: readonly number[],
): AggregateScore {
  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const hitAt: Record<number, number> = {};
  const recallAt: Record<number, number> = {};
  for (const k of ks) {
    hitAt[k] = mean(scores.map((score) => (score.hitAt[k] ? 1 : 0)));
    recallAt[k] = mean(scores.map((score) => score.recallAt[k] ?? 0));
  }
  return {
    cases: scores.length,
    hitAt,
    recallAt,
    mrr: mean(scores.map((score) => score.reciprocalRank)),
  };
}

/**
 * How well a similarity threshold separates questions the site answers from questions it does
 * not. A *false abstention* sends a visitor to WhatsApp although the answer is on the site
 * (annoying, safe). A *false confidence* lets the model see unrelated chunks for a question the
 * site does not answer (the model still has to refuse, so it is a second line of defence
 * failing, not a wrong answer by itself). Cases marked `any` are not counted.
 */
export interface GateStats {
  threshold: number;
  answerable: number;
  falseAbstentions: number;
  unanswerable: number;
  falseConfidence: number;
  /** Mean of the two per-class accuracies, so the larger class does not dominate. */
  balancedAccuracy: number;
}

export interface GateItem {
  expect: GateExpectation;
  bestSimilarity: number | null;
  bestLexicalCoverage: number | null;
}

/**
 * Counts for one similarity threshold. `minLexicalCoverage` turns on the lexical way through the
 * gate (see `gateDecision` in retrieval/service.ts); null measures the semantic signal alone.
 */
export function gateStats(
  items: readonly GateItem[],
  threshold: number,
  minLexicalCoverage: number | null,
): GateStats {
  const confident = (item: GateItem) =>
    (item.bestSimilarity !== null && item.bestSimilarity >= threshold) ||
    (minLexicalCoverage !== null &&
      item.bestLexicalCoverage !== null &&
      item.bestLexicalCoverage >= minLexicalCoverage);
  const answerable = items.filter((item) => item.expect === "answer");
  const unanswerable = items.filter((item) => item.expect === "abstain");
  const falseAbstentions = answerable.filter((item) => !confident(item)).length;
  const falseConfidence = unanswerable.filter(confident).length;
  const accuracy = (total: number, wrong: number) => (total === 0 ? 1 : (total - wrong) / total);
  return {
    threshold,
    answerable: answerable.length,
    falseAbstentions,
    unanswerable: unanswerable.length,
    falseConfidence,
    balancedAccuracy:
      (accuracy(answerable.length, falseAbstentions) +
        accuracy(unanswerable.length, falseConfidence)) /
      2,
  };
}

export function sweepThresholds(
  items: readonly GateItem[],
  thresholds: readonly number[],
  minLexicalCoverage: number | null,
): GateStats[] {
  return thresholds.map((threshold) => gateStats(items, threshold, minLexicalCoverage));
}

export interface ThresholdRecommendation {
  from: number;
  to: number;
  midpoint: number;
  falseAbstentions: number;
  falseConfidence: number;
}

/**
 * The policy for picking the threshold (ADR 0011), decided before looking at the numbers:
 *
 * 1. Fewest false abstentions. Refusing a question the site answers defeats the purpose of the
 *    assistant; letting an unanswerable one through still leaves the agent, told to answer only
 *    from its sources, to say that the site does not cover it.
 * 2. Then fewest false confidences.
 * 3. Among the thresholds that tie, the widest interval, and its midpoint: the same margin on
 *    both sides, because the next real question will not sit exactly where the dataset's did.
 */
export function recommendThreshold(sweep: readonly GateStats[]): ThresholdRecommendation | null {
  if (sweep.length === 0) return null;
  const fewestAbstentions = Math.min(...sweep.map((row) => row.falseAbstentions));
  const candidates = sweep.filter((row) => row.falseAbstentions === fewestAbstentions);
  const fewestConfidence = Math.min(...candidates.map((row) => row.falseConfidence));
  const isBest = (row: GateStats) =>
    row.falseAbstentions === fewestAbstentions && row.falseConfidence === fewestConfidence;
  let best: { from: number; to: number } | null = null;
  let run: { from: number; to: number } | null = null;
  for (const row of sweep) {
    if (!isBest(row)) {
      run = null;
      continue;
    }
    run = run ? { from: run.from, to: row.threshold } : { from: row.threshold, to: row.threshold };
    if (!best || run.to - run.from > best.to - best.from) best = { ...run };
  }
  if (!best) return null;
  return {
    ...best,
    midpoint: (best.from + best.to) / 2,
    falseAbstentions: fewestAbstentions,
    falseConfidence: fewestConfidence,
  };
}

/** p-th percentile (0-100) by nearest rank. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] as number;
}
