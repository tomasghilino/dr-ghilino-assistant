import { readFileSync } from "node:fs";
import type { EmbeddingProvider } from "../../src/embeddings/provider.ts";
import {
  type IngestionOptions,
  type IngestionReport,
  runIngestion,
  sourcesFileSchema,
} from "../../src/ingestion/index.ts";
import { fakeFetch, SITE } from "./fixtures.ts";
import type { TestDatabase } from "./pglite.ts";

export const FIXTURE_SOURCES = sourcesFileSchema.parse(
  JSON.parse(readFileSync(new URL("../../../../knowledge/sources.json", import.meta.url), "utf8")),
).sources;

export function ingestionOptions(overrides: Partial<IngestionOptions> = {}): IngestionOptions {
  return {
    sources: FIXTURE_SOURCES,
    chunking: { targetTokens: 220, maxTokens: 400, overlapTokens: 40 },
    dedupeThreshold: 0.8,
    userAgent: "test",
    fetchTimeoutMs: 5_000,
    maxBytes: 2_000_000,
    trigger: "test",
    ...overrides,
  };
}

/** Index the saved copy of the site into a test database, exactly as `pnpm cli ingest` would. */
export function ingestFixtures(
  t: TestDatabase,
  embeddings: EmbeddingProvider,
  homeHtml: string = SITE.homeHtml(),
): Promise<IngestionReport> {
  const site = fakeFetch({
    [SITE.homeUrl]: { body: homeHtml },
    [SITE.llmsUrl]: { body: SITE.llmsTxt(), contentType: "text/plain" },
  });
  return runIngestion({ rpc: t.rpc, embeddings, fetch: site.fetch }, ingestionOptions());
}
