import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chunkKey,
  RANKING_MODES,
  retrievalEvalFileSchema,
  runRetrievalEval,
  thresholdRange,
} from "../src/evaluation/index.ts";
import {
  assembleContext,
  RetrievalService,
  type RetrievalSettings,
} from "../src/retrieval/index.ts";
import { createTestDatabase, HashingEmbeddings, type TestDatabase } from "./support/index.ts";
import { ingestFixtures } from "./support/ingest-fixtures.ts";

const SETTINGS: RetrievalSettings = {
  topK: 5,
  candidates: 20,
  rrfK: 60,
  minSimilarity: 0.2,
  minLexicalCoverage: 1,
  dedupeThreshold: 0.8,
  cacheSize: 256,
  cacheTtlMs: 600_000,
};

describe("RetrievalService (PGlite, site fixtures, offline embeddings)", () => {
  let t: TestDatabase;
  let embeddings: HashingEmbeddings;
  let service: RetrievalService;

  beforeAll(async () => {
    t = await createTestDatabase();
    await ingestFixtures(t, new HashingEmbeddings());
  });
  afterAll(async () => {
    await t.close();
  });
  const fresh = (settings: Partial<RetrievalSettings> = {}) => {
    embeddings = new HashingEmbeddings();
    service = new RetrievalService({ rpc: t.rpc, embeddings }, { ...SETTINGS, ...settings });
    return service;
  };

  it("embeds the question as a query and returns ranked, citable chunks", async () => {
    const result = await fresh().search({ query: "¿Cuánto cuesta la consulta?" });
    expect(embeddings.calls).toEqual([
      { texts: ["¿Cuánto cuesta la consulta?"], inputType: "query" },
    ]);
    expect(result.confident).toBe(true);
    expect(result.chunks.length).toBeLessThanOrEqual(5);
    expect(result.chunks[0]?.headingPath.at(-1)).toBe("¿Cuánto cuesta la consulta?");
    expect(result.chunks[0]?.url).toMatch(/^https:\/\/drluisghilino\.com\.ar\//);
    expect(result.usage).toEqual({ embeddingTokens: expect.any(Number), cacheHit: false });
  });

  it("reuses the cached query embedding", async () => {
    const svc = fresh();
    await svc.search({ query: "horarios" });
    const second = await svc.search({ query: "  horarios " });
    expect(embeddings.calls).toHaveLength(1);
    expect(second.usage).toEqual({ embeddingTokens: 0, cacheHit: true });
  });

  it("abstains when neither signal passes, but still reports what it saw", async () => {
    // "osde" appears nowhere, so no chunk covers the whole question.
    const result = await fresh({ minSimilarity: 0.99 }).search({ query: "¿atiende por OSDE?" });
    expect(result).toMatchObject({ confident: false, gate: "none" });
    expect(result.bestSimilarity).toBeLessThan(0.99);
    expect(result.bestLexicalCoverage).toBe(0.5);
    expect(result.chunks.length).toBeGreaterThan(0);
  });

  it("passes the gate on exact terms when meaning alone would not", async () => {
    const result = await fresh({ minSimilarity: 0.99 }).search({ query: "virrey vertiz 117" });
    expect(result).toMatchObject({ confident: true, gate: "lexical", bestLexicalCoverage: 1 });
    expect(result.chunks[0]?.headingPath.at(-1)).toBe("Boulogne");
  });

  it("never calls the providers for an empty question", async () => {
    const result = await fresh().search({ query: "   " });
    expect(result).toMatchObject({ confident: false, chunks: [] });
    expect(embeddings.calls).toHaveLength(0);
  });

  it("drops near-duplicate results across sources", async () => {
    // The llms.txt summary repeats the home page; whatever survives must not repeat itself.
    const result = await fresh({ topK: 10 }).search({ query: "matrícula y formación" });
    const keys = result.chunks.map((c) => chunkKey(c.headingPath));
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(result.chunks.map((c) => c.contentHash)).size).toBe(result.chunks.length);
  });

  it("assembles a context that fits the budget", async () => {
    const result = await fresh().search({ query: "¿Dónde atiende?" });
    const context = assembleContext(result.chunks, 300);
    expect(context.tokens).toBeLessThanOrEqual(300);
    expect(context.sources.length).toBeGreaterThan(0);
    expect(context.text.match(/<source /g)).toHaveLength(context.sources.length);
  });

  it("runs the evaluation end to end with one embeddings call", async () => {
    const file = retrievalEvalFileSchema.parse(
      JSON.parse(
        readFileSync(new URL("../../../evals/retrieval-cases.json", import.meta.url), "utf8"),
      ),
    );
    const svc = fresh();
    const report = await runRetrievalEval(svc, file, {
      ks: [1, 3, 5],
      mrrCutoff: 10,
      thresholds: thresholdRange(0.1, 0.6, 0.05),
      settings: SETTINGS,
      now: () => new Date("2026-11-05T00:00:00Z"),
    });
    expect(embeddings.calls).toHaveLength(1);
    expect(report.usage.serviceCacheMisses).toBe(0);
    expect(report.dataset.cases).toBe(file.cases.length);
    expect(Object.keys(report.metrics)).toEqual([...RANKING_MODES]);
    // Every alias names a chunk that exists in the indexed site.
    expect(report.unseenAliases).toEqual([]);
    // Reports carry chunk keys, never chunk content.
    expect(JSON.stringify(report)).not.toContain("El valor de la consulta es de $50.000");
  });
});
