import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type IngestionOptions, runIngestion, sourcesFileSchema } from "../src/ingestion/index.ts";
import { fakeFetch, SITE } from "./support/fixtures.ts";
import { createTestDatabase, HashingEmbeddings, type TestDatabase } from "./support/index.ts";

const SOURCES = sourcesFileSchema.parse(
  JSON.parse(readFileSync(new URL("../../../knowledge/sources.json", import.meta.url), "utf8")),
).sources;

function options(overrides: Partial<IngestionOptions> = {}): IngestionOptions {
  return {
    sources: SOURCES,
    chunking: { targetTokens: 220, maxTokens: 400, overlapTokens: 40 },
    dedupeThreshold: 0.8,
    userAgent: "test",
    fetchTimeoutMs: 5_000,
    maxBytes: 2_000_000,
    trigger: "test",
    ...overrides,
  };
}

describe("ingestion pipeline (PGlite + fixtures + offline embeddings)", () => {
  let t: TestDatabase;
  let embeddings: HashingEmbeddings;
  let homeHtml: string;
  let site: ReturnType<typeof fakeFetch>;

  beforeEach(async () => {
    t = await createTestDatabase();
    embeddings = new HashingEmbeddings();
    homeHtml = SITE.homeHtml();
    site = fakeFetch({
      [SITE.homeUrl]: () => ({ body: homeHtml }),
      [SITE.llmsUrl]: { body: SITE.llmsTxt(), contentType: "text/plain" },
    });
  });
  afterEach(async () => {
    await t.close();
  });

  const run = (overrides: Partial<IngestionOptions> = {}) =>
    runIngestion({ rpc: t.rpc, embeddings, fetch: site.fetch }, options(overrides));

  it("indexes the site, deduplicates llms.txt and publishes the clinic profile", async () => {
    const report = await run();
    expect(report.status).toBe("succeeded");
    expect(report.sources.map((s) => [s.id, s.outcome, s.chunks, s.duplicatesDropped])).toEqual([
      ["site-home", "published", 22, 0],
      ["site-llms", "published", 3, 9],
    ]);
    expect(report.profile.outcome).toBe("published");

    const status = await t.rpc.value<Record<string, unknown>>("assistant_status");
    expect(status).toMatchObject({
      sources: 2,
      documents: 2,
      active_versions: 2,
      chunks: 25,
      embedding_models: ["test-hashing-v1"],
      has_clinic_profile: true,
    });
    expect(embeddings.calls.every((call) => call.inputType === "document")).toBe(true);

    const run1 = await t.db.query<{ status: string; stats: { sources: unknown[] } }>(
      "select status, stats from public.kb_ingestion_runs",
    );
    expect(run1.rows[0]?.status).toBe("succeeded");
    expect(JSON.stringify(run1.rows[0]?.stats)).not.toContain("Boulogne"); // stats hold no content
  });

  it("does nothing on a second run when the site has not changed", async () => {
    await run();
    const before = embeddings.calls.length;
    const report = await run();
    expect(report.sources.map((s) => s.outcome)).toEqual(["unchanged", "unchanged"]);
    expect(report.profile.outcome).toBe("unchanged");
    expect(embeddings.calls.length).toBe(before); // no embedding calls at all
    const { rows } = await t.db.query<{ n: number }>(
      "select count(*)::int as n from public.kb_document_versions",
    );
    expect(rows[0]?.n).toBe(2);
  });

  it("ignores markup-only changes such as a new build hash", async () => {
    await run();
    homeHtml = homeHtml.replaceAll("/_next/static/", "/_next/static/rebuilt-");
    const report = await run();
    expect(report.sources[0]?.outcome).toBe("unchanged");
  });

  it("re-embeds only the chunk whose text changed", async () => {
    await run();
    // React splits some visible strings across text nodes; this one is a single node in the HTML.
    homeHtml = homeHtml.replace(
      'text-muted">Corrección del arco del pie.</p>',
      'text-muted">Corrección del arco del pie con plantillas a medida.</p>',
    );
    const report = await run();
    const home = report.sources.find((s) => s.id === "site-home");
    expect(home).toMatchObject({ outcome: "published", version: 2, chunks: 22 });
    expect(home?.embedded).toBe(1); // the "Plantillas y pie plano" chunk
    expect(home?.reused).toBe(21);

    const { rows } = await t.db.query<{ content: string }>(`
      select c.content from public.kb_chunks c
      join public.kb_document_versions v on v.id = c.document_version_id
      where v.status = 'active' and c.anchor_url like '%#patologia-pie-plano'`);
    expect(rows[0]?.content).toContain("plantillas a medida");
  });

  it("keeps the knowledge base when a source fails, and reports a partial run", async () => {
    await run();
    site = fakeFetch({ [SITE.homeUrl]: () => ({ body: homeHtml }) }); // llms.txt now unreachable
    const report = await run();
    expect(report.status).toBe("partial");
    expect(report.sources.find((s) => s.id === "site-llms")?.outcome).toBe("failed");
    expect(report.removedDocuments).toBe(0);
    const status = await t.rpc.value<{ documents: number }>("assistant_status");
    expect(status.documents).toBe(2);
  });

  it("removes a document when its source is disabled", async () => {
    await run();
    const sources = SOURCES.map((s) => (s.id === "site-llms" ? { ...s, enabled: false } : s));
    const report = await run({ sources });
    expect(report.removedDocuments).toBe(1);
    expect(await t.rpc.value("assistant_status")).toMatchObject({ documents: 1, chunks: 22 });
  });

  it("writes nothing and embeds nothing in a dry run", async () => {
    const report = await runIngestion({ rpc: t.rpc, fetch: site.fetch }, options({ dryRun: true }));
    expect(report.sources.map((s) => s.outcome)).toEqual(["dry_run", "dry_run"]);
    expect(report.chunks.filter((c) => c.kept)).toHaveLength(25);
    const { rows } = await t.db.query<{ n: number }>(
      "select count(*)::int as n from public.kb_ingestion_runs",
    );
    expect(rows[0]?.n).toBe(0);
  });

  it("re-embeds everything with --force", async () => {
    await run();
    const report = await run({ force: true });
    expect(report.sources.map((s) => [s.outcome, s.embedded, s.reused])).toEqual([
      ["published", 22, 0],
      ["published", 3, 0],
    ]);
  });
});
