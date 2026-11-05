import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foldForSearch, toVectorLiteral } from "../src/index.ts";
import { createTestDatabase, listMigrations, type TestDatabase } from "./support/index.ts";

const DOC_ID = "00000000-0000-0000-0000-000000000001";
const VERSION_ID = "00000000-0000-0000-0000-0000000000a1";
const APP_TABLES = [
  "kb_ingestion_runs",
  "kb_sources",
  "kb_documents",
  "kb_document_versions",
  "kb_chunks",
  "clinic_profiles",
  "chat_sessions",
  "rate_limit_buckets",
  "request_metrics",
];

describe("migration files", () => {
  it("follow InsForge's naming rule <14-digit version>_<lowercase-hyphenated-name>.sql", async () => {
    const files = await listMigrations();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file).toMatch(/^\d{14}_[a-z0-9]+(-[a-z0-9]+)*\.sql$/);
  });
});

describe("initial schema", () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t.close();
  });

  it("enables row-level security on every app table", async () => {
    const { rows } = await t.db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' and relname = any($1)`,
      [APP_TABLES],
    );
    expect(rows.map((row) => row.relname).sort()).toEqual([...APP_TABLES].sort());
    for (const row of rows) expect(row.relrowsecurity, row.relname).toBe(true);
  });

  it("reproduces InsForge's default grants, so the next test is not vacuous", async () => {
    await t.db.exec(
      "set role project_admin; create table public.grant_probe (id int); reset role;",
    );
    const { rows } = await t.db.query<{ ok: boolean }>(
      "select has_table_privilege('anon', 'public.grant_probe', 'SELECT') as ok",
    );
    expect(rows[0]?.ok).toBe(true);
    await t.db.exec("drop table public.grant_probe");
  });

  it("revokes the default grants InsForge gives the browser roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of APP_TABLES) {
        const { rows } = await t.db.query<{ ok: boolean }>(
          "select has_table_privilege($1, $2, 'SELECT, INSERT, UPDATE, DELETE') as ok",
          [role, `public.${table}`],
        );
        expect(rows[0]?.ok, `${role} on ${table}`).toBe(false);
      }
      await expect(
        t.db.transaction(async (tx) => {
          await tx.exec(`set local role ${role}`);
          await tx.query("select count(*) from public.kb_chunks");
        }),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("lets only the admin role call the status function", async () => {
    const status = await t.rpc.value<Record<string, unknown>>("assistant_status");
    expect(status).toMatchObject({
      sources: 0,
      documents: 0,
      chunks: 0,
      has_clinic_profile: false,
    });
    await expect(t.rpcAs("anon").value("assistant_status")).rejects.toThrow(/permission denied/);
    await expect(t.rpcAs("authenticated").value("assistant_status")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("indexes chunks for lexical (accent-insensitive) and semantic search", async () => {
    const vector = toVectorLiteral(Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)));
    const text =
      "Consultorio de Boulogne: Virrey Vértiz 117. Lunes, martes y viernes desde las 18 h.";
    await t.db.query(
      `insert into public.kb_sources (id, url, kind) values ('site-home', 'https://drluisghilino.com.ar/', 'html_page')`,
    );
    await t.db.query(
      `insert into public.kb_documents (id, source_id, canonical_url, title)
       values ($1, 'site-home', 'https://drluisghilino.com.ar/', 'Inicio')`,
      [DOC_ID],
    );
    await t.db.query(
      `insert into public.kb_document_versions
         (id, document_id, version, content_hash, content, status, fetched_at)
       values ($1, $2, 1, repeat('a', 64), 'x', 'active', now())`,
      [VERSION_ID, DOC_ID],
    );
    await t.db.query(
      `insert into public.kb_chunks (document_version_id, ordinal, anchor_url, content, search_text,
         token_estimate, content_hash, embedding, embedding_model)
       values ($1, 0, 'https://drluisghilino.com.ar/#consultorio-boulogne', $2, $3, 20,
               repeat('b', 64), $4, 'test-model')`,
      [VERSION_ID, text, foldForSearch(text), vector],
    );

    // Lexical: the visitor types without accents; the folded index still matches.
    const lexical = await t.db.query<{ n: number }>(
      "select count(*)::int as n from public.kb_chunks where fts @@ websearch_to_tsquery('spanish', $1)",
      [foldForSearch("Vertiz viernes")],
    );
    expect(lexical.rows[0]?.n).toBe(1);

    // Semantic: cosine distance 0 to the same vector.
    const semantic = await t.db.query<{ d: number }>(
      "select embedding <=> $1 as d from public.kb_chunks limit 1",
      [vector],
    );
    expect(semantic.rows[0]?.d).toBeCloseTo(0, 6);

    expect(await t.rpc.value("assistant_status")).toMatchObject({
      documents: 1,
      chunks: 1,
      embedding_models: ["test-model"],
    });
  });

  it("allows only one active version per document", async () => {
    await expect(
      t.db.query(
        `insert into public.kb_document_versions (document_id, version, content_hash, content, status, fetched_at)
         values ($1, 2, repeat('c', 64), 'y', 'active', now())`,
        [DOC_ID],
      ),
    ).rejects.toThrow(/kb_document_versions_one_active/);
  });

  it("rejects an embedding with the wrong number of dimensions", async () => {
    await expect(
      t.db.query(
        `insert into public.kb_chunks (document_version_id, ordinal, anchor_url, content, search_text,
           token_estimate, content_hash, embedding, embedding_model)
         values ($1, 1, 'https://drluisghilino.com.ar/', 'x', 'x', 1, repeat('d', 64), '[1,2,3]', 'test-model')`,
        [VERSION_ID],
      ),
    ).rejects.toThrow(/expected 1024 dimensions/);
  });
});
