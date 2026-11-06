import type { Agent, AgentFlag, ConversationTurn } from "../agent/agent.ts";
import type { AnswerKind, Channel, ContactAction, SourceRef } from "../domain/types.ts";
import { AppError } from "../lib/errors.ts";
import { estimateEmbeddingCostUsd, estimateLlmCostUsd } from "../llm/pricing.ts";
import { type LlmUsage, ZERO_USAGE } from "../llm/types.ts";
import {
  cleanMessage,
  detectEmergency,
  type EmergencyKind,
  redactPersonalData,
} from "../safety/input.ts";

/**
 * One conversation, one agent, many channels (docs/architecture.md §9). A channel adapter (the web
 * API now, a WhatsApp webhook later) turns its input into an InboundMessage and renders the
 * OutboundMessage; everything in between is the same code, with the same safety rules.
 */
export interface InboundMessage {
  channel: Channel;
  /** Null or unknown starts a new conversation. */
  conversationId: string | null;
  text: string;
}

export interface OutboundMessage {
  conversationId: string;
  answer: string;
  kind: AnswerKind;
  sources: SourceRef[];
  actions: ContactAction[];
  telemetry: ChatTelemetry;
}

/** Content-free numbers about one message, for `request_metrics` (no text, no ids). */
export interface ChatTelemetry {
  fastPath: EmergencyKind | null;
  model: string | null;
  usage: LlmUsage;
  llmCalls: number;
  toolCalls: string[];
  embeddingTokens: number;
  estimatedCostUsd: number;
  latencyMs: number;
  llmMs: number;
  toolMs: number;
  retrievalMs: number;
  retrievedChunks: number;
  topSimilarity: number | null;
  redactions: number;
  flags: AgentFlag[];
}

/** Where recent turns live between messages (ADR 0007). Implementations encrypt and expire. */
export interface SessionStore {
  load(conversationId: string): Promise<ConversationTurn[] | null>;
  save(conversationId: string, channel: Channel, turns: ConversationTurn[]): Promise<void>;
  delete(conversationId: string): Promise<void>;
}

export interface ChatSettings {
  maxMessageChars: number;
  historyTurns: number;
  emergencyText: string;
  crisisText: string;
  embeddingModel: string;
}

export class ChatService {
  constructor(
    private readonly deps: {
      agent: Agent;
      sessions: SessionStore;
      newId?: () => string;
    },
    private readonly settings: ChatSettings,
  ) {}

  async handle(message: InboundMessage): Promise<OutboundMessage> {
    const started = performance.now();
    const text = cleanMessage(message.text, this.settings.maxMessageChars);
    if (text === "") {
      throw new AppError("validation", "El mensaje está vacío.");
    }

    const known = message.conversationId
      ? await this.deps.sessions.load(message.conversationId)
      : null;
    const conversationId =
      known && message.conversationId ? message.conversationId : (this.deps.newId ?? uuid)();

    // Emergencies get a fixed answer at once: no model, no tools, nothing stored.
    const emergency = detectEmergency(text);
    if (emergency) {
      return {
        conversationId,
        answer: emergency === "self_harm" ? this.settings.crisisText : this.settings.emergencyText,
        kind: "emergency",
        sources: [],
        actions: [],
        telemetry: {
          ...emptyTelemetry(),
          fastPath: emergency,
          latencyMs: performance.now() - started,
        },
      };
    }

    const redacted = redactPersonalData(text);
    const history = known ?? [];
    const result = await this.deps.agent.run({ message: redacted.text, history });

    // Only redacted text is kept, and only the last few turns.
    const turns = [
      ...history,
      { role: "visitor", text: redacted.text } satisfies ConversationTurn,
      { role: "assistant", text: result.answer } satisfies ConversationTurn,
    ].slice(-this.settings.historyTurns * 2);
    await this.deps.sessions.save(conversationId, message.channel, turns);

    const llmCost = estimateLlmCostUsd(result.model, result.usage) ?? 0;
    const embeddingCost =
      estimateEmbeddingCostUsd(this.settings.embeddingModel, result.retrieval.embeddingTokens) ?? 0;
    return {
      conversationId,
      answer: result.answer,
      kind: result.kind,
      sources: result.sources,
      actions: result.actions,
      telemetry: {
        fastPath: null,
        model: result.model,
        usage: result.usage,
        llmCalls: result.llmCalls,
        toolCalls: result.toolCalls,
        embeddingTokens: result.retrieval.embeddingTokens,
        estimatedCostUsd: llmCost + embeddingCost,
        latencyMs: performance.now() - started,
        llmMs: result.timings.llmMs,
        toolMs: result.timings.toolMs,
        retrievalMs: result.timings.retrievalMs,
        retrievedChunks: result.retrieval.chunks,
        topSimilarity: result.retrieval.bestSimilarity,
        redactions:
          redacted.redactions.email + redacted.redactions.phone + redacted.redactions.document,
        flags: result.flags,
      },
    };
  }

  /** "Borrar conversación": the visitor's explicit request wins over the expiry. */
  reset(conversationId: string): Promise<void> {
    return this.deps.sessions.delete(conversationId);
  }
}

function emptyTelemetry(): ChatTelemetry {
  return {
    fastPath: null,
    model: null,
    usage: ZERO_USAGE,
    llmCalls: 0,
    toolCalls: [],
    embeddingTokens: 0,
    estimatedCostUsd: 0,
    latencyMs: 0,
    llmMs: 0,
    toolMs: 0,
    retrievalMs: 0,
    retrievedChunks: 0,
    topSimilarity: null,
    redactions: 0,
    flags: [],
  };
}

function uuid(): string {
  return crypto.randomUUID();
}

/** In-process sessions: for the CLI and tests. The API uses the encrypted SQL store. */
export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, ConversationTurn[]>();

  async load(conversationId: string): Promise<ConversationTurn[] | null> {
    return this.sessions.get(conversationId) ?? null;
  }

  async save(conversationId: string, _channel: Channel, turns: ConversationTurn[]): Promise<void> {
    this.sessions.set(conversationId, turns);
  }

  async delete(conversationId: string): Promise<void> {
    this.sessions.delete(conversationId);
  }
}
