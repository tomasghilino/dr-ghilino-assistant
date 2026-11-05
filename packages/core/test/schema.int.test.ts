import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foldForSearch, toVectorLiteral } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "./support/index.ts";

const DOC_ID = "00000000-0000-0000-0000-000000000001";
const VERSION_ID = "00000000-0000-0000-0000-0000000000a1";

describe("initial schema", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });

  it("seeds the allowlisted sources", async () => {
    const { rows } = await t.db.query<{ id: string }>(
      "select id from assistant.sources order by id",
    );
    expect(rows.map((row) => row.id)).toEqual(["site-home", "site-jsonld", "site-llms"]);
  });

  it("enables row-level security on every table", async () => {
    const { rows } = await t.db.query<{ relname: string; relrowsecurity: boolean }>(`
      select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'assistant' and c.relkind = 'r'`);
    expect(rows.length).toBeGreaterThanOrEqual(9);
    for (const row of rows) expect(row.relrowsecurity, row.relname).toBe(true);
  });

  it("denies the public roles any access to the private schema", async () => {
    for (const role of ["anon", "authenticated"]) {
      await expect(
        t.db.transaction(async (tx) => {
          await tx.exec(`set local role ${role}`);
          await tx.query("select count(*) from assistant.chunks");
        }),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("indexes chunks for lexical (accent-insensitive) and semantic search", async () => {
    const vector = toVectorLiteral(Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)));
    const text =
      "Consultorio de Boulogne: Virrey Vértiz 117. Lunes, martes y viernes desde las 18 h.";
    await t.db.query(
      `insert into assistant.documents (id, source_id, canonical_url, title)
       values ($1, 'site-home', 'https://drluisghilino.com.ar/', 'Inicio')`,
      [DOC_ID],
    );
    await t.db.query(
      `insert into assistant.document_versions
         (id, document_id, version, content_hash, content, status, fetched_at)
       values ($1, $2, 1, repeat('a', 64), 'x', 'active', now())`,
      [VERSION_ID, DOC_ID],
    );
    await t.db.query(
      `insert into assistant.chunks (document_version_id, ordinal, anchor_url, content, search_text,
         token_estimate, content_hash, embedding, embedding_model)
       values ($1, 0, 'https://drluisghilino.com.ar/#consultorio-boulogne', $2, $3, 20,
               repeat('b', 64), $4, 'test-model')`,
      [VERSION_ID, text, foldForSearch(text), vector],
    );

    // Lexical: the visitor types without accents; the folded index still matches.
    const lexical = await t.db.query<{ n: number }>(
      "select count(*)::int as n from assistant.chunks where fts @@ websearch_to_tsquery('spanish', $1)",
      [foldForSearch("Vertiz viernes")],
    );
    expect(lexical.rows[0]?.n).toBe(1);

    // Semantic: cosine distance 0 to the same vector.
    const semantic = await t.db.query<{ d: number }>(
      "select embedding <=> $1 as d from assistant.chunks limit 1",
      [vector],
    );
    expect(semantic.rows[0]?.d).toBeCloseTo(0, 6);
  });

  it("allows only one active version per document", async () => {
    await expect(
      t.db.query(
        `insert into assistant.document_versions (document_id, version, content_hash, content, status, fetched_at)
         values ($1, 2, repeat('c', 64), 'y', 'active', now())`,
        [DOC_ID],
      ),
    ).rejects.toThrow(/document_versions_one_active/);
  });

  it("rejects an embedding with the wrong number of dimensions", async () => {
    await expect(
      t.db.query(
        `insert into assistant.chunks (document_version_id, ordinal, anchor_url, content, search_text,
           token_estimate, content_hash, embedding, embedding_model)
         values ($1, 1, 'https://drluisghilino.com.ar/', 'x', 'x', 1, repeat('d', 64), '[1,2,3]', 'test-model')`,
        [VERSION_ID],
      ),
    ).rejects.toThrow(/expected 1024 dimensions/);
  });
});
