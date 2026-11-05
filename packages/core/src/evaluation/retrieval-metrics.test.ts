import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { retrievalEvalFileSchema } from "./retrieval-dataset.ts";
import {
  aggregateScores,
  gateStats,
  percentile,
  recommendThreshold,
  scoreRanking,
  sweepThresholds,
} from "./retrieval-metrics.ts";
import { thresholdRange } from "./retrieval-runner.ts";

describe("scoreRanking", () => {
  it("computes Hit@K, Recall@K and reciprocal rank with requirement groups", () => {
    const ranked = ["x", "fee", "y", "whatsapp", "z"];
    const groups = [["fee", "hero"], ["whatsapp"]];
    const score = scoreRanking(ranked, groups, [1, 3, 5], 10);
    expect(score.firstRelevantRank).toBe(2);
    expect(score.reciprocalRank).toBe(0.5);
    expect(score.hitAt).toEqual({ 1: false, 3: true, 5: true });
    expect(score.recallAt).toEqual({ 1: 0, 3: 0.5, 5: 1 });
  });

  it("gives 0 when nothing relevant is retrieved within the cutoff", () => {
    const score = scoreRanking(["a", "b", "c"], [["c"]], [1], 2);
    expect(score.reciprocalRank).toBe(0);
    expect(score.firstRelevantRank).toBe(3);
  });

  it("averages over cases", () => {
    const a = scoreRanking(["r"], [["r"]], [1], 10);
    const b = scoreRanking(["x", "r"], [["r"]], [1], 10);
    expect(aggregateScores([a, b], [1])).toEqual({
      cases: 2,
      hitAt: { 1: 0.5 },
      recallAt: { 1: 0.5 },
      mrr: 0.75,
    });
  });
});

describe("confidence gate statistics", () => {
  const item = (
    expect: "answer" | "abstain" | "any",
    sim: number,
    coverage: number | null = null,
  ) => ({
    expect,
    bestSimilarity: sim,
    bestLexicalCoverage: coverage,
  });
  const items = [
    item("answer", 0.6),
    item("answer", 0.4),
    item("abstain", 0.3),
    item("abstain", 0.2),
    item("any", 0.9),
  ];

  it("counts false abstentions and false confidence, ignoring 'any'", () => {
    expect(gateStats(items, 0.5, null)).toMatchObject({
      answerable: 2,
      falseAbstentions: 1,
      unanswerable: 2,
      falseConfidence: 0,
      balancedAccuracy: 0.75,
    });
    expect(gateStats(items, 0.25, null)).toMatchObject({
      falseAbstentions: 0,
      falseConfidence: 1,
    });
  });

  it("lets a full lexical match through when the lexical signal is on", () => {
    const withAddress = [...items, item("answer", 0.1, 1)];
    expect(gateStats(withAddress, 0.35, null).falseAbstentions).toBe(1);
    expect(gateStats(withAddress, 0.35, 1).falseAbstentions).toBe(0);
  });

  it("recommends the middle of the widest interval with no false abstentions", () => {
    const sweep = sweepThresholds(items, thresholdRange(0.2, 0.6, 0.05), null);
    expect(sweep.map((s) => s.threshold)).toEqual([
      0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6,
    ]);
    // 0.35 and 0.4 separate both classes (0.3 < t <= 0.4).
    expect(recommendThreshold(sweep)).toEqual({
      from: 0.35,
      to: 0.4,
      midpoint: 0.375,
      falseAbstentions: 0,
      falseConfidence: 0,
    });
  });

  it("prefers no false abstentions over fewer false confidences", () => {
    const overlapping = [item("answer", 0.5), item("answer", 0.3), item("abstain", 0.4)];
    const sweep = sweepThresholds(overlapping, thresholdRange(0.2, 0.6, 0.1), null);
    // 0.5 would stop the 0.4 abstain case but refuse the 0.3 answerable one: not chosen.
    expect(recommendThreshold(sweep)).toMatchObject({
      from: 0.2,
      to: 0.3,
      falseAbstentions: 0,
      falseConfidence: 1,
    });
  });

  it("computes nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBe(0);
  });
});

describe("evals/retrieval-cases.json", () => {
  const raw = JSON.parse(
    readFileSync(new URL("../../../../evals/retrieval-cases.json", import.meta.url), "utf8"),
  );

  it("is valid: unique ids, known aliases, answerable cases have relevant chunks", () => {
    const file = retrievalEvalFileSchema.parse(raw);
    expect(file.cases.length).toBeGreaterThanOrEqual(36);
    const categories = new Set(file.cases.map((c) => c.category));
    expect(categories.size).toBe(8);
  });

  it("rejects an unknown alias", () => {
    const broken = structuredClone(raw);
    broken.cases[0].relevant = [["does-not-exist"]];
    expect(retrievalEvalFileSchema.safeParse(broken).success).toBe(false);
  });
});
