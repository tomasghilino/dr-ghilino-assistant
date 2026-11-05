import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foldForSearch, toVectorLiteral } from "../src/index.ts";
import { SITE } from "./support/fixtures.ts";
import { createTestDatabase, HashingEmbeddings, type TestDatabase } from "./support/index.ts";
import { ingestFixtures } from "./support/ingest-fixtures.ts";

interface Row {
  heading_path: string[];
  source_id: string;
  content: string;
  semantic_rank: number | null;
  semantic_similarity: number | null;
  lexical_rank: number | null;
  lexical_coverage: number | null;
  rrf_score: number;
  best_similarity: number;
  best_lexical_coverage: number | null;
}

describe("kb_hybrid_search (PGlite, site fixtures, offline embeddings)", () => {
  let t: TestDatabase;
  const embeddings = new HashingEmbeddings();

  const search = (query: string, extra: Record<string, unknown> = {}) =>
    t.rpc.rows<Row>("kb_hybrid_search", {
      p_query_embedding: toVectorLiteral(embeddings.vector(query)),
      p_query_text: foldForSearch(query),
      p_embedding_model: embeddings.model,
      p_match_count: 10,
      p_candidates: 20,
      p_rrf_k: 60,
      ...extra,
    } as Record<string, string | number>);
  const leaf = (row: Row | undefined) => row?.heading_path.at(-1);

  beforeAll(async () => {
    t = await createTestDatabase();
    await ingestFixtures(t, embeddings);
  });
  afterAll(async () => {
    await t.close();
  });

  it("finds an address typed without accents through the lexical index", async () => {
    const rows = await search("Virrey Vertiz 117");
    const boulogne = rows.find((row) => leaf(row) === "Boulogne");
    expect(boulogne?.lexical_rank).toBe(1);
    expect(leaf(rows[0])).toBe("Boulogne");
  });

  it("reports how much of the question each chunk contains", async () => {
    const rows = await search("virrey vertiz 117 domingo");
    const boulogne = rows.find((row) => leaf(row) === "Boulogne");
    // virrey, vertiz and 117 are there; "doming" is not: 3 of 4 lexemes.
    expect(boulogne?.lexical_coverage).toBeCloseTo(0.75, 10);
    expect(rows[0]?.best_lexical_coverage).toBeCloseTo(0.75, 10);
    for (const row of rows) if (row.lexical_rank === null) expect(row.lexical_coverage).toBeNull();
  });

  it("treats question words as alternatives, not as all-required", async () => {
    // "sale" appears in no chunk; with AND semantics the fee FAQ would not match lexically at all.
    const rows = await search("¿cuánto sale la consulta?");
    const fee = rows.find((row) => leaf(row) === "¿Cuánto cuesta la consulta?");
    expect(fee?.lexical_rank).not.toBeNull();
  });

  it("computes Reciprocal Rank Fusion from both ranks", async () => {
    const rows = await search("infiltraciones de rodilla con ácido hialurónico");
    for (const row of rows) {
      const expected =
        (row.semantic_rank ? 1 / (60 + row.semantic_rank) : 0) +
        (row.lexical_rank ? 1 / (60 + row.lexical_rank) : 0);
      expect(row.rrf_score).toBeCloseTo(expected, 10);
    }
    const scores = rows.map((row) => row.rrf_score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    const best = Math.max(...rows.map((row) => row.semantic_similarity ?? -1));
    expect(rows[0]?.best_similarity).toBeCloseTo(best, 10);
  });

  it("still ranks semantically when the question has only stop words", async () => {
    const rows = await search("¿y de la?");
    expect(rows.every((row) => row.lexical_rank === null)).toBe(true);
    expect(rows[0]?.best_lexical_coverage).toBeNull();
    expect(rows.length).toBeGreaterThan(0);
  });

  it("filters by source and by embedding model", async () => {
    const llmsOnly = await search("patologías", { p_source_ids: ["site-llms"] } as never);
    expect(llmsOnly.length).toBeGreaterThan(0);
    expect(llmsOnly.every((row) => row.source_id === "site-llms")).toBe(true);
    expect(await search("patologías", { p_embedding_model: "another-model" })).toEqual([]);
  });

  it("never returns chunks of a superseded version", async () => {
    const changed = SITE.homeHtml().replace(
      'text-muted">Corrección del arco del pie.</p>',
      'text-muted">Plantillas ortopédicas a medida.</p>',
    );
    await ingestFixtures(t, embeddings, changed);
    // llms.txt (unchanged) still says "Corrección del arco del pie.", so look at the page only.
    const rows = await search("corrección del arco del pie", {
      p_match_count: 30,
      p_candidates: 50,
      p_source_ids: ["site-home"],
    } as never);
    expect(rows.some((row) => row.content.includes("Corrección del arco del pie."))).toBe(false);
    expect(rows.some((row) => row.content.includes("Plantillas ortopédicas a medida."))).toBe(true);
  });

  it("is not callable with the public key", async () => {
    await expect(
      t.rpcAs("anon").rows("kb_hybrid_search", {
        p_query_embedding: toVectorLiteral(embeddings.vector("x")),
        p_query_text: "x",
        p_embedding_model: embeddings.model,
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
