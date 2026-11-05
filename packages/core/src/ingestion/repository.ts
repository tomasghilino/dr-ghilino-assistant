import type { RpcClient } from "../db/rpc.ts";
import type { ClinicProfile } from "../domain/clinic-profile.ts";
import type { SourceConfig } from "./sources.ts";

export interface DocumentState {
  document_id: string;
  version_id: string | null;
  version: number | null;
  content_hash: string | null;
  pipeline_fingerprint: string | null;
  removed: boolean;
}

export interface ChunkRow {
  ordinal: number;
  heading_path: string[];
  anchor_url: string;
  content: string;
  search_text: string;
  token_estimate: number;
  content_hash: string;
  embedding: string;
  embedding_model: string;
}

export interface DocumentRow {
  canonical_url: string;
  title: string;
  language: string;
  content_hash: string;
  content: string;
  metadata: Record<string, unknown>;
  fetched_at: string;
}

export interface InventoryRow {
  canonical_url: string;
  title: string;
  source_id: string;
  version: number | null;
  content_hash: string | null;
  indexed_at: string | null;
  chunks: number;
  embedding_model: string | null;
  removed: boolean;
}

/** Typed wrapper over the ingestion SQL functions (migrations/*kb-ingestion-functions.sql). */
export class KnowledgeRepository {
  constructor(private readonly rpc: RpcClient) {}

  upsertSource(source: SourceConfig): Promise<void> {
    return this.rpc.value("kb_upsert_source", {
      p_id: source.id,
      p_url: source.url,
      p_kind: source.kind,
      p_description: source.description,
      p_enabled: source.enabled,
    });
  }

  startRun(trigger: "manual" | "scheduled" | "ci" | "test"): Promise<string> {
    return this.rpc.value<string>("kb_start_ingestion_run", { p_trigger: trigger });
  }

  finishRun(
    runId: string,
    status: "succeeded" | "partial" | "failed",
    stats: object,
    error: string | null,
  ): Promise<void> {
    return this.rpc.value("kb_finish_ingestion_run", {
      p_run_id: runId,
      p_status: status,
      p_stats: stats,
      p_error: error,
    });
  }

  async documentState(canonicalUrl: string): Promise<DocumentState | undefined> {
    const rows = await this.rpc.rows<DocumentState>("kb_document_state", {
      p_canonical_url: canonicalUrl,
    });
    return rows[0];
  }

  /** content hash → vector, for chunks already embedded with this model. */
  async reusableEmbeddings(contentHashes: string[], model: string): Promise<Map<string, string>> {
    if (contentHashes.length === 0) return new Map();
    const rows = await this.rpc.rows<{ content_hash: string; embedding: string }>(
      "kb_reusable_embeddings",
      { p_content_hashes: contentHashes, p_model: model },
    );
    return new Map(rows.map((row) => [row.content_hash, row.embedding]));
  }

  publishDocumentVersion(
    sourceId: string,
    document: DocumentRow,
    chunks: ChunkRow[],
    runId: string,
  ): Promise<{ document_id: string; version_id: string; version: number; chunks: number }> {
    return this.rpc.value("kb_publish_document_version", {
      p_source_id: sourceId,
      p_document: document,
      p_chunks: chunks,
      p_run_id: runId,
    });
  }

  removeDocumentsExcept(keepUrls: string[]): Promise<number> {
    return this.rpc.value<number>("kb_remove_documents_except", { p_keep_urls: keepUrls });
  }

  publishClinicProfile(
    profile: ClinicProfile,
    contentHash: string,
    sourceUrl: string,
    runId: string,
  ): Promise<{ changed: boolean; id: string }> {
    return this.rpc.value("clinic_publish_profile", {
      p_profile: profile,
      p_content_hash: contentHash,
      p_source_url: sourceUrl,
      p_run_id: runId,
    });
  }

  inventory(): Promise<InventoryRow[]> {
    return this.rpc.rows<InventoryRow>("kb_inventory");
  }
}
