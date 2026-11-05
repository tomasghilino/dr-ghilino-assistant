import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  createEmbeddingProvider,
  InsforgeRpcClient,
  ingestConfigSchema,
  ingestionSettingsSchema,
  parseConfig,
  type RpcClient,
} from "@ghilino/core";
import {
  type IngestionReport,
  KnowledgeRepository,
  runIngestion,
  sourcesFileSchema,
} from "@ghilino/core/ingestion";
import { createAdminClient } from "@insforge/sdk";

const USAGE = `Usage: pnpm cli ingest [--dry-run] [--show-chunks] [--force] [--source <id>]...

  --dry-run      Fetch, extract, chunk and deduplicate only. No embeddings, no database writes.
  --show-chunks  With --dry-run, print every chunk's full text.
  --force        Re-embed and republish even if nothing changed.
  --source <id>  Only this source (repeatable). Unseen documents are not removed.`;

export async function ingestCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "dry-run": { type: "boolean", default: false },
      "show-chunks": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      source: { type: "string", multiple: true },
      trigger: { type: "string", default: "manual" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const dryRun = values["dry-run"];
  const settings = parseConfig(ingestionSettingsSchema, process.env);
  const sourcesFile = sourcesFileSchema.parse(
    JSON.parse(readFileSync(settings.INGEST_SOURCES_FILE, "utf8")),
  );
  const unknown = (values.source ?? []).filter(
    (id) => !sourcesFile.sources.some((s) => s.id === id),
  );
  if (unknown.length > 0) {
    console.error(`Unknown source id(s): ${unknown.join(", ")}`);
    return 1;
  }

  let rpc: RpcClient = noDatabase;
  let embeddings: ReturnType<typeof createEmbeddingProvider> | undefined;
  if (!dryRun) {
    const config = parseConfig(ingestConfigSchema, process.env);
    rpc = new InsforgeRpcClient(
      createAdminClient({
        baseUrl: config.INSFORGE_BASE_URL,
        apiKey: config.INSFORGE_API_KEY,
        timeout: 30_000,
      }),
    );
    embeddings = createEmbeddingProvider(config);
  }

  const report = await runIngestion(
    { rpc, fetch, ...(embeddings ? { embeddings } : {}) },
    {
      sources: sourcesFile.sources,
      chunking: {
        targetTokens: settings.CHUNK_TARGET_TOKENS,
        maxTokens: settings.CHUNK_MAX_TOKENS,
        overlapTokens: settings.CHUNK_OVERLAP_TOKENS,
      },
      dedupeThreshold: settings.DEDUPE_CONTAINMENT_THRESHOLD,
      userAgent: settings.INGEST_USER_AGENT,
      fetchTimeoutMs: settings.INGEST_FETCH_TIMEOUT_MS,
      maxBytes: settings.INGEST_MAX_BYTES,
      trigger:
        values.trigger === "ci" || values.trigger === "scheduled" ? values.trigger : "manual",
      force: values.force,
      dryRun,
      ...(values.source ? { onlySourceIds: values.source } : {}),
    },
  );
  printReport(report, values["show-chunks"]);
  return report.status === "succeeded" ? 0 : 1;
}

export async function kbListCommand(): Promise<number> {
  const config = parseConfig(ingestConfigSchema, process.env);
  const repo = new KnowledgeRepository(
    new InsforgeRpcClient(
      createAdminClient({ baseUrl: config.INSFORGE_BASE_URL, apiKey: config.INSFORGE_API_KEY }),
    ),
  );
  const rows = await repo.inventory();
  if (rows.length === 0) {
    console.log("The knowledge base is empty. Run `pnpm cli ingest`.");
    return 0;
  }
  for (const row of rows) {
    const state = row.removed ? "removed" : `v${row.version}`;
    console.log(
      `${state.padEnd(8)} ${String(row.chunks).padStart(3)} chunks  ${row.embedding_model ?? "-"}  ${row.indexed_at ?? ""}  ${row.canonical_url}`,
    );
  }
  return 0;
}

function printReport(report: IngestionReport, showChunks: boolean): void {
  console.log(
    `\n${report.dryRun ? "Dry run" : `Run ${report.runId}`}: ${report.status} in ${report.durationMs} ms`,
  );
  for (const source of report.sources) {
    const detail =
      source.outcome === "failed"
        ? source.error
        : `${source.chunks} chunks, ${source.duplicatesDropped} duplicates dropped, ${source.embedded} embedded, ${source.reused} reused${source.version ? `, version ${source.version}` : ""}`;
    console.log(`  ${source.outcome.padEnd(14)} ${source.id.padEnd(12)} ${detail}`);
  }
  console.log(
    `  clinic profile: ${report.profile.outcome}${report.profile.error ? ` (${report.profile.error})` : ""}`,
  );
  if (!report.dryRun) {
    console.log(
      `  removed documents: ${report.removedDocuments}, embedding tokens: ${report.embeddingTokens}`,
    );
  }

  if (report.dryRun) {
    console.log(
      "\nChunks (✓ kept, ✗ dropped; c = share already covered by a more authoritative source):",
    );
    for (const chunk of report.chunks) {
      const mark = chunk.kept ? "✓" : "✗";
      const anchor = chunk.anchorUrl.replace(/^https:\/\/[^/]+/, "");
      console.log(
        `  ${mark} ${chunk.sourceId.padEnd(10)} #${String(chunk.ordinal).padStart(2)} ${String(chunk.tokens).padStart(4)} tok  c=${chunk.containment.toFixed(2)}  ${anchor.padEnd(28)} ${chunk.headingPath.join(" › ")}`,
      );
      if (showChunks) console.log(`${chunk.content.replace(/^/gm, "      │ ")}\n`);
    }
  }
}

/** A dry run must never touch the database; any call here is a bug. */
const noDatabase: RpcClient = {
  rows: async (fn) => {
    throw new Error(`dry run attempted a database call (${fn})`);
  },
  value: async (fn) => {
    throw new Error(`dry run attempted a database call (${fn})`);
  },
};
