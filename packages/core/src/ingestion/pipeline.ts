import { EMBEDDING_DIMENSIONS } from "../config/env.ts";
import { type RpcClient, toVectorLiteral } from "../db/rpc.ts";
import type { ClinicProfile } from "../domain/clinic-profile.ts";
import type { EmbeddingProvider } from "../embeddings/provider.ts";
import { sha256Hex } from "../lib/hash.ts";
import { stableStringify } from "../lib/json.ts";
import { type ChunkingOptions, chunkDocument } from "./chunker.ts";
import { dedupeChunks } from "./dedupe.ts";
import { extractClinicProfile } from "./extract-clinic-profile.ts";
import { extractHtml } from "./extract-html.ts";
import { extractMarkdown } from "./extract-markdown.ts";
import { fetchSource } from "./fetch-source.ts";
import { type ChunkRow, KnowledgeRepository } from "./repository.ts";
import type { SourceConfig } from "./sources.ts";
import type { ChunkDraft, ExtractedDocument } from "./types.ts";

/**
 * Bump when extraction or chunking logic changes in a way that should re-index every document even
 * if the site did not change. It is part of the pipeline fingerprint stored with each version.
 */
export const PIPELINE_VERSION = "2026-11-05.1";

export interface IngestionDeps {
  rpc: RpcClient;
  /** Not needed for a dry run. */
  embeddings?: EmbeddingProvider;
  fetch: typeof fetch;
}

export interface IngestionOptions {
  sources: SourceConfig[];
  chunking: ChunkingOptions;
  dedupeThreshold: number;
  userAgent: string;
  fetchTimeoutMs: number;
  maxBytes: number;
  trigger?: "manual" | "scheduled" | "ci" | "test";
  /** Re-embed and republish even when nothing changed. */
  force?: boolean;
  /** Fetch, extract, chunk and dedupe only: no embeddings, no database writes. */
  dryRun?: boolean;
  /** Limit the run to these source ids. Disables removal of unseen documents. */
  onlySourceIds?: readonly string[];
}

export type SourceOutcome = "published" | "unchanged" | "all_duplicates" | "failed" | "dry_run";

export interface SourceReport {
  id: string;
  url: string;
  outcome: SourceOutcome;
  documentUrl?: string;
  version?: number;
  chunks: number;
  duplicatesDropped: number;
  embedded: number;
  reused: number;
  error?: string;
}

export interface ChunkPreview {
  sourceId: string;
  ordinal: number;
  tokens: number;
  anchorUrl: string;
  headingPath: string[];
  kept: boolean;
  dropReason?: string;
  containment: number;
  content: string;
}

export interface IngestionReport {
  runId: string | null;
  status: "succeeded" | "partial" | "failed";
  dryRun: boolean;
  fingerprint: string;
  durationMs: number;
  sources: SourceReport[];
  profile: { outcome: "published" | "unchanged" | "dry_run" | "none" | "failed"; error?: string };
  removedDocuments: number;
  embeddingTokens: number;
  chunks: ChunkPreview[];
}

interface Prepared {
  source: SourceConfig;
  document: ExtractedDocument;
  documentHash: string;
  fetchedAt: Date;
  chunks: Array<{ draft: ChunkDraft; hash: string }>;
  profile?: ClinicProfile;
}

/**
 * One ingestion run, in three phases:
 *  A. per source: fetch → extract → chunk (and the clinic profile from JSON-LD);
 *  B. across sources: drop chunks already covered by more authoritative ones;
 *  C. per document: skip if unchanged, else embed only new chunks and publish a version atomically.
 *
 * Failures are contained per source: one bad page does not stop the others, and documents of a
 * source that failed are never removed (a network error must not empty the knowledge base).
 */
export async function runIngestion(
  deps: IngestionDeps,
  options: IngestionOptions,
): Promise<IngestionReport> {
  const started = Date.now();
  const dryRun = options.dryRun ?? false;
  if (!dryRun && !deps.embeddings) throw new Error("an embedding provider is required");
  const repo = new KnowledgeRepository(deps.rpc);
  const fingerprint = await pipelineFingerprint(options, deps.embeddings?.model ?? "none");
  const report: IngestionReport = {
    runId: null,
    status: "succeeded",
    dryRun,
    fingerprint,
    durationMs: 0,
    sources: [],
    profile: { outcome: "none" },
    removedDocuments: 0,
    embeddingTokens: 0,
    chunks: [],
  };

  if (!dryRun) report.runId = await repo.startRun(options.trigger ?? "manual");
  try {
    if (!dryRun) for (const source of options.sources) await repo.upsertSource(source);

    const selected = options.sources
      .filter((source) => source.enabled)
      .filter((source) => !options.onlySourceIds || options.onlySourceIds.includes(source.id))
      .sort((a, b) => a.priority - b.priority);
    const allowedHosts = new Set(options.sources.map((source) => new URL(source.url).hostname));

    // Phase A
    const prepared: Prepared[] = [];
    for (const source of selected) {
      try {
        prepared.push(await prepare(source, deps.fetch, allowedHosts, options));
      } catch (error) {
        report.sources.push(failed(source, error));
      }
    }

    // Phase B
    const flat = prepared.flatMap((p) =>
      p.chunks.map((c) => ({ priority: p.source.priority, chunk: c.draft, contentHash: c.hash })),
    );
    const decisions = dedupeChunks(flat, options.dedupeThreshold);
    let cursor = 0;
    const kept = new Map<Prepared, Array<{ draft: ChunkDraft; hash: string }>>();
    for (const p of prepared) {
      const keep: Array<{ draft: ChunkDraft; hash: string }> = [];
      for (const chunk of p.chunks) {
        const decision = decisions[cursor++];
        if (decision?.keep) keep.push(chunk);
        report.chunks.push({
          sourceId: p.source.id,
          ordinal: chunk.draft.ordinal,
          tokens: chunk.draft.tokenEstimate,
          anchorUrl: chunk.draft.anchorUrl,
          headingPath: chunk.draft.headingPath,
          kept: decision?.keep ?? true,
          ...(decision?.reason ? { dropReason: decision.reason } : {}),
          containment: decision?.containment ?? 0,
          content: chunk.draft.content,
        });
      }
      kept.set(
        p,
        keep.map((chunk, ordinal) => ({ ...chunk, draft: { ...chunk.draft, ordinal } })),
      );
    }

    // Phase C
    const keepUrls: string[] = [];
    for (const p of prepared) {
      const chunks = kept.get(p) ?? [];
      try {
        const outcome = await publish(p, chunks, { repo, deps, options, fingerprint, report });
        report.sources.push(outcome);
        if (outcome.outcome === "published" || outcome.outcome === "unchanged") {
          keepUrls.push(p.document.canonicalUrl);
        }
      } catch (error) {
        report.sources.push(failed(p.source, error));
      }
    }

    // Clinic profile
    const withProfile = prepared.find((p) => p.profile);
    if (withProfile?.profile) {
      const hash = await sha256Hex(stableStringify(withProfile.profile));
      if (dryRun) report.profile = { outcome: "dry_run" };
      else {
        try {
          const result = await repo.publishClinicProfile(
            withProfile.profile,
            hash,
            withProfile.profile.sourceUrl,
            report.runId as string,
          );
          report.profile = { outcome: result.changed ? "published" : "unchanged" };
        } catch (error) {
          report.profile = { outcome: "failed", error: describe(error) };
        }
      }
    }

    const failures = report.sources.filter((s) => s.outcome === "failed").length;
    const profileFailed = report.profile.outcome === "failed";
    if (!dryRun && failures === 0 && !options.onlySourceIds) {
      report.removedDocuments = await repo.removeDocumentsExcept(keepUrls);
    }
    report.status =
      failures === 0 && !profileFailed ? "succeeded" : prepared.length > 0 ? "partial" : "failed";
    report.durationMs = Date.now() - started;
    if (report.runId) {
      await repo.finishRun(report.runId, report.status, summary(report), firstError(report));
    }
    return report;
  } catch (error) {
    report.status = "failed";
    report.durationMs = Date.now() - started;
    if (report.runId) {
      await repo
        .finishRun(report.runId, "failed", summary(report), describe(error))
        .catch(() => {});
    }
    throw error;
  }
}

async function prepare(
  source: SourceConfig,
  fetchImpl: typeof fetch,
  allowedHosts: ReadonlySet<string>,
  options: IngestionOptions,
): Promise<Prepared> {
  const fetched = await fetchSource(source.url, {
    fetch: fetchImpl,
    userAgent: options.userAgent,
    timeoutMs: options.fetchTimeoutMs,
    maxBytes: options.maxBytes,
    allowedHosts,
  });
  const document =
    source.kind === "html_page"
      ? extractHtml(fetched.body, fetched.finalUrl, {
          root: source.html?.root,
          exclude: source.html?.exclude,
        })
      : extractMarkdown(fetched.body, fetched.finalUrl, {
          excludeHeadings: source.markdown?.excludeHeadings,
        });
  const drafts = chunkDocument(document, options.chunking, { citeAs: source.citeAs });
  const chunks = await Promise.all(
    drafts.map(async (draft) => ({ draft, hash: await sha256Hex(draft.content) })),
  );
  const profile = source.html?.clinicProfile
    ? extractClinicProfile(fetched.body, document.canonicalUrl)
    : undefined;
  return {
    source,
    document,
    // Hash the extracted content, not the HTML: a rebuild of the site changes asset hashes and
    // class names in the markup every time, and that must not trigger a re-index.
    documentHash: await sha256Hex(
      stableStringify({ title: document.title, blocks: document.blocks }),
    ),
    fetchedAt: fetched.fetchedAt,
    chunks,
    ...(profile ? { profile } : {}),
  };
}

async function publish(
  p: Prepared,
  chunks: Array<{ draft: ChunkDraft; hash: string }>,
  ctx: {
    repo: KnowledgeRepository;
    deps: IngestionDeps;
    options: IngestionOptions;
    fingerprint: string;
    report: IngestionReport;
  },
): Promise<SourceReport> {
  const base = {
    id: p.source.id,
    url: p.source.url,
    documentUrl: p.document.canonicalUrl,
    chunks: chunks.length,
    duplicatesDropped: p.chunks.length - chunks.length,
    embedded: 0,
    reused: 0,
  };
  if (chunks.length === 0) return { ...base, outcome: "all_duplicates" };
  if (ctx.options.dryRun) return { ...base, outcome: "dry_run" };

  // The version hash covers the content and the exact chunk list it produced, so a change in
  // deduplication (another source changed) also counts as a change.
  const versionHash = await sha256Hex(
    [p.documentHash, ...chunks.map((chunk) => chunk.hash)].join("\n"),
  );
  const state = await ctx.repo.documentState(p.document.canonicalUrl);
  if (
    !ctx.options.force &&
    state &&
    !state.removed &&
    state.content_hash === versionHash &&
    state.pipeline_fingerprint === ctx.fingerprint
  ) {
    return { ...base, outcome: "unchanged", ...(state.version ? { version: state.version } : {}) };
  }

  const embeddings = ctx.deps.embeddings as EmbeddingProvider;
  const reusable = ctx.options.force
    ? new Map<string, string>()
    : await ctx.repo.reusableEmbeddings(
        chunks.map((chunk) => chunk.hash),
        embeddings.model,
      );
  const missing = chunks.filter((chunk) => !reusable.has(chunk.hash));
  const fresh = new Map<string, string>();
  if (missing.length > 0) {
    const result = await embeddings.embed(
      missing.map((chunk) => chunk.draft.content),
      "document",
    );
    missing.forEach((chunk, i) => {
      fresh.set(chunk.hash, toVectorLiteral(result.vectors[i] as number[]));
    });
    ctx.report.embeddingTokens += result.tokens;
  }

  const rows: ChunkRow[] = chunks.map((chunk) => ({
    ordinal: chunk.draft.ordinal,
    heading_path: chunk.draft.headingPath,
    anchor_url: chunk.draft.anchorUrl,
    content: chunk.draft.content,
    search_text: chunk.draft.searchText,
    token_estimate: chunk.draft.tokenEstimate,
    content_hash: chunk.hash,
    embedding: (reusable.get(chunk.hash) ?? fresh.get(chunk.hash)) as string,
    embedding_model: embeddings.model,
  }));
  const published = await ctx.repo.publishDocumentVersion(
    p.source.id,
    {
      canonical_url: p.document.canonicalUrl,
      title: p.document.title,
      language: p.document.language,
      content_hash: versionHash,
      content: renderDocument(p.document),
      metadata: {
        pipeline_fingerprint: ctx.fingerprint,
        pipeline_version: PIPELINE_VERSION,
        document_hash: p.documentHash,
        source_url: p.source.url,
        duplicates_dropped: base.duplicatesDropped,
      },
      fetched_at: p.fetchedAt.toISOString(),
    },
    rows,
    ctx.report.runId as string,
  );
  return {
    ...base,
    outcome: "published",
    version: published.version,
    embedded: missing.length,
    reused: chunks.length - missing.length,
  };
}

/** Everything that changes how a document becomes chunks and vectors. */
async function pipelineFingerprint(options: IngestionOptions, model: string): Promise<string> {
  return sha256Hex(
    stableStringify({
      version: PIPELINE_VERSION,
      chunking: options.chunking,
      dedupeThreshold: options.dedupeThreshold,
      model,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  );
}

/** Plain-text rendering kept with each version, for history and audits. */
function renderDocument(document: ExtractedDocument): string {
  return document.blocks
    .map((block) =>
      block.kind === "heading" ? `${"#".repeat(block.level)} ${block.text}` : block.text,
    )
    .join("\n");
}

function failed(source: SourceConfig, error: unknown): SourceReport {
  return {
    id: source.id,
    url: source.url,
    outcome: "failed",
    chunks: 0,
    duplicatesDropped: 0,
    embedded: 0,
    reused: 0,
    error: describe(error),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function firstError(report: IngestionReport): string | null {
  return report.sources.find((s) => s.error)?.error ?? report.profile.error ?? null;
}

/** What goes into kb_ingestion_runs.stats: counts and outcomes, no content. */
function summary(report: IngestionReport): object {
  return {
    fingerprint: report.fingerprint,
    duration_ms: report.durationMs,
    embedding_tokens: report.embeddingTokens,
    removed_documents: report.removedDocuments,
    profile: report.profile.outcome,
    sources: report.sources.map((s) => ({
      id: s.id,
      outcome: s.outcome,
      version: s.version ?? null,
      chunks: s.chunks,
      duplicates_dropped: s.duplicatesDropped,
      embedded: s.embedded,
      reused: s.reused,
    })),
  };
}
