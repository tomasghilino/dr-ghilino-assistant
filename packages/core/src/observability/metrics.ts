import type { ChatTelemetry } from "../chat/service.ts";
import type { RpcClient } from "../db/rpc.ts";
import type { AnswerKind, Channel } from "../domain/types.ts";

/**
 * One content-free row per request (docs/architecture.md §6, docs/privacy.md). It has no column for message
 * text, session ids or IP addresses, so they cannot end up there by accident.
 */
export type RequestOutcome =
  | "ok"
  | "error"
  | "rate_limited"
  | "rejected"
  | "emergency_fast_path"
  | "budget_exceeded";

export interface RequestMetric {
  requestId: string;
  channel: Channel | "internal";
  route: string;
  outcome: RequestOutcome;
  errorCategory?: string | null;
  answerKind?: AnswerKind | null;
  latencyMs: number;
  telemetry?: ChatTelemetry;
}

export interface MetricsSink {
  record(metric: RequestMetric): Promise<void>;
}

export class SqlMetricsSink implements MetricsSink {
  constructor(private readonly rpc: RpcClient) {}

  async record(metric: RequestMetric): Promise<void> {
    const t = metric.telemetry;
    await this.rpc.value("metrics_record", {
      p_row: {
        request_id: metric.requestId,
        channel: metric.channel,
        route: metric.route,
        outcome: metric.outcome,
        error_category: metric.errorCategory ?? null,
        answer_kind: metric.answerKind ?? null,
        latency_ms: Math.round(metric.latencyMs),
        retrieval_ms: t ? Math.round(t.retrievalMs) : null,
        llm_ms: t ? Math.round(t.llmMs) : null,
        tool_ms: t ? Math.round(t.toolMs) : null,
        llm_calls: t?.llmCalls ?? 0,
        tool_calls: t?.toolCalls ?? [],
        model: t?.model ?? null,
        input_tokens: t?.usage.inputTokens ?? 0,
        output_tokens: t?.usage.outputTokens ?? 0,
        cache_read_tokens: t?.usage.cacheReadTokens ?? 0,
        cache_write_tokens: t?.usage.cacheWriteTokens ?? 0,
        embedding_tokens: t?.embeddingTokens ?? 0,
        estimated_cost_usd: t?.estimatedCostUsd ?? 0,
        retrieved_chunks: t ? t.retrievedChunks : null,
        top_similarity: t?.topSimilarity ?? null,
      },
    });
  }
}

/** For tests and local runs without a database. */
export class MemoryMetricsSink implements MetricsSink {
  readonly records: RequestMetric[] = [];
  async record(metric: RequestMetric): Promise<void> {
    this.records.push(metric);
  }
}
