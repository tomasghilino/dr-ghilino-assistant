import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toVectorLiteral } from "../src/index.ts";
import { createTestDatabase, type TestDatabase } from "./support/index.ts";

const URL_HOME = "https://drluisghilino.com.ar/";
const hash = (c: string) => c.repeat(64);
const unitVector = (i: number) =>
  toVectorLiteral(Array.from({ length: 1024 }, (_, j) => (j === i ? 1 : 0)));

function chunk(
  ordinal: number,
  contentHash: string,
  embedding: string | null = unitVector(ordinal),
) {
  return {
    ordinal,
    heading_path: ["Consultorios", `Sección ${ordinal}`],
    anchor_url: `${URL_HOME}#consultorios`,
    content: `Texto ${ordinal}`,
    search_text: `texto ${ordinal}`,
    token_estimate: 3,
    content_hash: contentHash,
    embedding,
    embedding_model: embedding ? "test-model" : null,
  };
}

function document(contentHash: string, fingerprint = "fp-1") {
  return {
    canonical_url: URL_HOME,
    title: "Dr. Luis Ghilino",
    language: "es",
    content_hash: contentHash,
    content: "contenido",
    metadata: { pipeline_fingerprint: fingerprint },
    fetched_at: "2026-11-05T20:00:00Z",
  };
}

describe("ingestion SQL functions", () => {
  let t: TestDatabase;
  let runId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    await t.rpc.value("kb_upsert_source", {
      p_id: "site-home",
      p_url: URL_HOME,
      p_kind: "html_page",
      p_description: "Home",
      p_enabled: true,
    });
    runId = await t.rpc.value<string>("kb_start_ingestion_run", { p_trigger: "test" });
  });
  afterAll(async () => {
    await t.close();
  });

  it("upserts sources idempotently", async () => {
    await t.rpc.value("kb_upsert_source", {
      p_id: "site-home",
      p_url: URL_HOME,
      p_kind: "html_page",
      p_description: "Home page",
      p_enabled: true,
    });
    const { rows } = await t.db.query<{ description: string }>(
      "select description from public.kb_sources",
    );
    expect(rows).toEqual([{ description: "Home page" }]);
  });

  it("reports no state for a URL that was never published", async () => {
    expect(await t.rpc.rows("kb_document_state", { p_canonical_url: URL_HOME })).toEqual([]);
  });

  it("publishes a version with its chunks atomically", async () => {
    const result = await t.rpc.value<{ version: number; chunks: number }>(
      "kb_publish_document_version",
      {
        p_source_id: "site-home",
        p_document: document(hash("a")),
        p_chunks: [chunk(0, hash("1")), chunk(1, hash("2"))],
        p_run_id: runId,
      },
    );
    expect(result).toMatchObject({ version: 1, chunks: 2 });

    const [state] = await t.rpc.rows<{
      version: number;
      content_hash: string;
      pipeline_fingerprint: string;
    }>("kb_document_state", { p_canonical_url: URL_HOME });
    expect(state).toMatchObject({
      version: 1,
      content_hash: hash("a"),
      pipeline_fingerprint: "fp-1",
    });

    const { rows } = await t.db.query<{ heading_path: string[] }>(
      "select heading_path from public.kb_chunks order by ordinal",
    );
    expect(rows[1]?.heading_path).toEqual(["Consultorios", "Sección 1"]);
  });

  it("rolls back everything when one chunk is invalid", async () => {
    await expect(
      t.rpc.value("kb_publish_document_version", {
        p_source_id: "site-home",
        p_document: document(hash("b")),
        p_chunks: [chunk(0, hash("3")), { ...chunk(1, hash("4")), embedding: "[1,2,3]" }],
        p_run_id: runId,
      }),
    ).rejects.toThrow(/expected 1024 dimensions/);
    const [state] = await t.rpc.rows<{ version: number }>("kb_document_state", {
      p_canonical_url: URL_HOME,
    });
    expect(state?.version).toBe(1);
    const { rows } = await t.db.query<{ n: number }>(
      "select count(*)::int as n from public.kb_document_versions",
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("supersedes the previous version and keeps one active", async () => {
    await t.rpc.value("kb_publish_document_version", {
      p_source_id: "site-home",
      p_document: document(hash("c")),
      p_chunks: [chunk(0, hash("1")), chunk(1, hash("5"))],
      p_run_id: runId,
    });
    const { rows } = await t.db.query<{ version: number; status: string }>(
      "select version, status from public.kb_document_versions order by version",
    );
    expect(rows).toEqual([
      { version: 1, status: "superseded" },
      { version: 2, status: "active" },
    ]);
  });

  it("finds embeddings it can reuse by chunk hash and model", async () => {
    const rows = await t.rpc.rows<{ content_hash: string; embedding: string }>(
      "kb_reusable_embeddings",
      { p_content_hashes: [hash("1"), hash("9")], p_model: "test-model" },
    );
    expect(rows.map((row) => row.content_hash)).toEqual([hash("1")]);
    expect(JSON.parse(rows[0]?.embedding ?? "[]")).toHaveLength(1024);
    expect(
      await t.rpc.rows("kb_reusable_embeddings", {
        p_content_hashes: [hash("1")],
        p_model: "another-model",
      }),
    ).toEqual([]);
  });

  it("prunes chunks of old superseded versions but keeps the version rows", async () => {
    for (const c of ["d", "e", "f"]) {
      await t.rpc.value("kb_publish_document_version", {
        p_source_id: "site-home",
        p_document: document(hash(c)),
        p_chunks: [chunk(0, hash(c === "d" ? "6" : c === "e" ? "7" : "8"))],
        p_run_id: runId,
      });
    }
    const { rows } = await t.db.query<{ version: number; status: string; chunks: number }>(`
      select v.version, v.status, (select count(*)::int from public.kb_chunks c where c.document_version_id = v.id) as chunks
      from public.kb_document_versions v order by v.version`);
    expect(rows.map((row) => [row.version, row.status, row.chunks])).toEqual([
      [1, "superseded", 0],
      [2, "superseded", 0],
      [3, "superseded", 1],
      [4, "superseded", 1],
      [5, "active", 1],
    ]);
  });

  it("removes documents no longer produced by any source", async () => {
    expect(await t.rpc.value("kb_remove_documents_except", { p_keep_urls: [URL_HOME] })).toBe(0);
    expect(await t.rpc.value("kb_remove_documents_except", { p_keep_urls: [] })).toBe(1);
    const [state] = await t.rpc.rows<{ removed: boolean; version_id: string | null }>(
      "kb_document_state",
      { p_canonical_url: URL_HOME },
    );
    expect(state).toMatchObject({ removed: true, version_id: null });
    const { rows } = await t.db.query<{ n: number }>(
      "select count(*)::int as n from public.kb_document_versions where status = 'active'",
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("publishes the clinic profile only when it changes", async () => {
    const args = (h: string) => ({
      p_profile: { offices: [] },
      p_content_hash: hash(h),
      p_source_url: URL_HOME,
      p_run_id: runId,
    });
    expect(await t.rpc.value("clinic_publish_profile", args("a"))).toMatchObject({ changed: true });
    expect(await t.rpc.value("clinic_publish_profile", args("a"))).toMatchObject({
      changed: false,
    });
    expect(await t.rpc.value("clinic_publish_profile", args("b"))).toMatchObject({ changed: true });
    const { rows } = await t.db.query<{ status: string }>(
      "select status from public.clinic_profiles order by created_at, status",
    );
    expect(rows.map((row) => row.status).sort()).toEqual(["active", "superseded"]);
  });

  it("closes runs, rejects double finishes and abandons stale ones", async () => {
    await t.rpc.value("kb_finish_ingestion_run", {
      p_run_id: runId,
      p_status: "succeeded",
      p_stats: { documents: 1 },
      p_error: null,
    });
    await expect(
      t.rpc.value("kb_finish_ingestion_run", {
        p_run_id: runId,
        p_status: "succeeded",
        p_stats: {},
        p_error: null,
      }),
    ).rejects.toThrow(/is not running/);

    const stale = await t.rpc.value<string>("kb_start_ingestion_run", { p_trigger: "test" });
    await t.db.query(
      "update public.kb_ingestion_runs set started_at = now() - interval '2 hours' where id = $1",
      [stale],
    );
    await t.rpc.value("kb_start_ingestion_run", { p_trigger: "test" });
    const { rows } = await t.db.query<{ status: string; error: string }>(
      "select status, error from public.kb_ingestion_runs where id = $1",
      [stale],
    );
    expect(rows[0]).toEqual({ status: "failed", error: "abandoned: still running after 1 hour" });
  });

  it("lists the inventory without chunk text", async () => {
    const rows = await t.rpc.rows<Record<string, unknown>>("kb_inventory");
    expect(rows[0]).toMatchObject({ canonical_url: URL_HOME, removed: true });
    expect(Object.keys(rows[0] ?? {})).not.toContain("content");
  });

  it("denies every ingestion function to the browser roles", async () => {
    for (const fn of ["kb_inventory", "kb_start_ingestion_run"]) {
      await expect(t.rpcAs("anon").rows(fn)).rejects.toThrow(/permission denied/);
      await expect(t.rpcAs("authenticated").rows(fn)).rejects.toThrow(/permission denied/);
    }
  });
});
