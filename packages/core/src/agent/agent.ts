import type { ClinicProfile } from "../domain/clinic-profile.ts";
import type { AnswerKind, ContactAction, SourceRef } from "../domain/types.ts";
import { AppError } from "../lib/errors.ts";
import {
  addUsage,
  type LlmBlock,
  type LlmMessage,
  type LlmProvider,
  type LlmUsage,
  ZERO_USAGE,
} from "../llm/types.ts";
import { guardOutput } from "../safety/output.ts";
import { type ActionType, FINAL_ANSWER_JSON_SCHEMA, parseFinalAnswer } from "./answer.ts";
import { buildContactActions, type ClinicRepository, localPhone } from "./clinic.ts";
import { buildSystemPrompt, dynamicContext } from "./prompt.ts";
import { SourceRegistry } from "./sources.ts";
import type { AgentTool, ToolOutcome } from "./tools.ts";

export interface AgentSettings {
  maxToolRounds: number;
  turnDeadlineMs: number;
  maxTokens: number;
  /** Previous visitor + assistant pairs the model sees. */
  historyTurns: number;
  maxAnswerChars: number;
  /** Random code in the system prompt; an answer that contains it is discarded. */
  canary: string;
  /** Hosts a URL in an answer may point to (answers should contain none). */
  allowedHosts: readonly string[];
  emergencyText: string;
}

/** A piece of the site given to the model up front (the "full context" baseline, no search). */
export interface PinnedSource {
  /** Heading path the model reads. */
  title: string;
  /** Title the visitor sees under the answer. */
  visibleTitle: string;
  url: string;
  content: string;
}

/** A previous turn, already redacted, as plain text (no tool calls, no thinking). */
export interface ConversationTurn {
  role: "visitor" | "assistant";
  text: string;
}

export type AgentFlag =
  | "canary"
  | "url_removed"
  | "truncated"
  | "uncited_answer"
  | "unknown_source"
  | "invalid_output"
  | "max_tokens"
  | "refusal"
  | "tool_limit"
  | "tool_error";

export interface AgentResult {
  answer: string;
  kind: AnswerKind;
  sources: SourceRef[];
  actions: ContactAction[];
  model: string;
  usage: LlmUsage;
  llmCalls: number;
  toolCalls: string[];
  timings: { totalMs: number; llmMs: number; toolMs: number; retrievalMs: number };
  retrieval: { embeddingTokens: number; bestSimilarity: number | null; chunks: number };
  flags: AgentFlag[];
}

/**
 * One visitor message → one answer (ADR 0006, docs/architecture.md §3 and §5).
 *
 * The model chooses tools; the server enforces the limits: at most `maxToolRounds` rounds, a
 * wall-clock deadline, validated tool inputs, and an answer that must follow the final-answer
 * schema and cite only sources returned this turn. Within the turn the conversation is
 * append-only (thinking blocks are replayed unchanged); across turns only plain text is kept.
 */
export class Agent {
  private readonly systemPrompt: string;
  private readonly tools: Map<string, AgentTool>;

  constructor(
    private readonly deps: {
      llm: LlmProvider;
      tools: AgentTool[];
      clinic: ClinicRepository;
      now?: () => Date;
      /** The whole site in the system prompt; registered as S1..Sn at the start of every turn. */
      website?: readonly PinnedSource[];
    },
    private readonly settings: AgentSettings,
  ) {
    this.systemPrompt = buildSystemPrompt({
      canary: settings.canary,
      website: (deps.website ?? []).map((source, index) => ({
        id: `S${index + 1}`,
        title: source.title,
        url: source.url,
        content: source.content,
      })),
    });
    this.tools = new Map(deps.tools.map((tool) => [tool.definition.name, tool]));
  }

  async run(input: {
    message: string;
    history: readonly ConversationTurn[];
  }): Promise<AgentResult> {
    const started = performance.now();
    const now = this.deps.now?.() ?? new Date();
    const registry = new SourceRegistry();
    for (const source of this.deps.website ?? [])
      registry.register(source.visibleTitle, source.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.turnDeadlineMs);

    const state = {
      usage: ZERO_USAGE,
      llmCalls: 0,
      llmMs: 0,
      toolMs: 0,
      retrievalMs: 0,
      toolCalls: [] as string[],
      embeddingTokens: 0,
      bestSimilarity: null as number | null,
      chunks: 0,
      flags: [] as AgentFlag[],
      model: this.deps.llm.model,
    };
    const messages: LlmMessage[] = [
      ...historyMessages(input.history, this.settings.historyTurns),
      { role: "user", content: [{ type: "text", text: input.message }] },
    ];
    const system = { stable: this.systemPrompt, dynamic: dynamicContext(now) };
    const toolDefinitions = [...this.tools.values()].map((tool) => tool.definition);

    const finish = async (draft: {
      answer: string;
      kind: AnswerKind;
      sourceIds: string[];
      actions: ActionType[];
    }): Promise<AgentResult> => {
      const profile = await this.safeProfile();
      const result = this.finalize(draft, registry, profile, state.flags);
      return {
        ...result,
        model: state.model,
        usage: state.usage,
        llmCalls: state.llmCalls,
        toolCalls: state.toolCalls,
        timings: {
          totalMs: performance.now() - started,
          llmMs: state.llmMs,
          toolMs: state.toolMs,
          retrievalMs: state.retrievalMs,
        },
        retrieval: {
          embeddingTokens: state.embeddingTokens,
          bestSimilarity: state.bestSimilarity,
          chunks: state.chunks,
        },
        flags: state.flags,
      };
    };

    try {
      // Rounds 0..maxToolRounds-1 run tools. If the model still asks for tools after that, it gets
      // one "limit reached" result and one last call to answer with what it has.
      for (let round = 0; round <= this.settings.maxToolRounds + 1; round++) {
        const callStarted = performance.now();
        const response = await this.deps.llm.complete({
          system,
          messages,
          tools: toolDefinitions,
          outputSchema: FINAL_ANSWER_JSON_SCHEMA,
          maxTokens: this.settings.maxTokens,
          signal: controller.signal,
        });
        state.llmMs += performance.now() - callStarted;
        state.llmCalls += 1;
        state.usage = addUsage(state.usage, response.usage);
        state.model = response.model;

        if (response.stopReason === "tool_use") {
          messages.push({ role: "assistant", content: response.content });
          const calls = response.content.filter(
            (block): block is Extract<LlmBlock, { type: "tool_call" }> =>
              block.type === "tool_call",
          );
          const overLimit = round >= this.settings.maxToolRounds;
          if (overLimit) state.flags.push("tool_limit");
          const toolStarted = performance.now();
          const outcomes = await Promise.all(
            calls.map((call) =>
              overLimit
                ? Promise.resolve<ToolOutcome>({
                    content:
                      "Tool limit reached for this message. Answer now with the information you already have, or say you could not check.",
                    isError: true,
                  })
                : this.runTool(call.name, call.input, registry),
            ),
          );
          state.toolMs += performance.now() - toolStarted;
          for (const [index, outcome] of outcomes.entries()) {
            const call = calls[index] as Extract<LlmBlock, { type: "tool_call" }>;
            if (!overLimit) state.toolCalls.push(call.name);
            if (outcome.isError && !overLimit && !state.flags.includes("tool_error"))
              state.flags.push("tool_error");
            if (outcome.metrics) {
              state.retrievalMs += outcome.metrics.retrievalMs;
              state.embeddingTokens += outcome.metrics.embeddingTokens;
              state.chunks += outcome.metrics.chunks;
              const similarity = outcome.metrics.bestSimilarity;
              if (similarity !== null)
                state.bestSimilarity = Math.max(state.bestSimilarity ?? -1, similarity);
            }
          }
          // All results go back in one user message, in call order.
          messages.push({
            role: "user",
            content: outcomes.map((outcome, index) => ({
              type: "tool_result",
              toolCallId: (calls[index] as { id: string }).id,
              content: outcome.content,
              isError: outcome.isError,
            })),
          });
          continue;
        }

        if (response.stopReason === "refusal") {
          state.flags.push("refusal");
          return await finish(this.fallback("refusal"));
        }
        if (response.stopReason === "max_tokens") {
          state.flags.push("max_tokens");
          return await finish(this.fallback("unavailable"));
        }

        const text = response.content
          .filter((block): block is Extract<LlmBlock, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join("");
        const parsed = parseFinalAnswer(text);
        if (!parsed) {
          state.flags.push("invalid_output");
          return await finish(this.fallback("unavailable"));
        }
        return await finish({
          answer: parsed.answer,
          kind: parsed.kind,
          sourceIds: parsed.source_ids,
          actions: parsed.actions,
        });
      }
      state.flags.push("tool_limit");
      return await finish(this.fallback("unavailable"));
    } catch (error) {
      if (controller.signal.aborted) {
        throw new AppError("timeout", "La respuesta tardó demasiado.", {
          cause: error,
          retryable: true,
          internalMessage: `turn deadline of ${this.settings.turnDeadlineMs} ms exceeded`,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async runTool(
    name: string,
    input: unknown,
    registry: SourceRegistry,
  ): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) return { content: `Unknown tool ${name}.`, isError: true };
    try {
      return await tool.run(input, { registry });
    } catch {
      // The error itself stays out of the conversation: it may carry upstream details.
      return {
        content: "The tool failed. Try another tool, or tell the visitor you could not check.",
        isError: true,
      };
    }
  }

  /** Citations, guard, contact buttons: everything between the model and the visitor. */
  private finalize(
    draft: { answer: string; kind: AnswerKind; sourceIds: string[]; actions: ActionType[] },
    registry: SourceRegistry,
    profile: ClinicProfile | null,
    flags: AgentFlag[],
  ): Pick<AgentResult, "answer" | "kind" | "sources" | "actions"> {
    let { answer, kind, actions } = draft;
    const { sources, unknown } = registry.resolve(draft.sourceIds);
    if (unknown.length > 0) flags.push("unknown_source");

    // A factual answer must rest on something the tools returned this turn.
    if (kind === "answered" && sources.length === 0) {
      flags.push("uncited_answer");
      ({ answer, kind, actions } = this.fallback("abstained", profile));
    }

    const guarded = guardOutput(answer, {
      canary: this.settings.canary,
      allowedHosts: this.settings.allowedHosts,
      maxChars: this.settings.maxAnswerChars,
    });
    for (const flag of guarded.flags) flags.push(flag);
    if (guarded.discard) {
      const safe = this.fallback("refusal", profile);
      return { answer: safe.answer, kind: safe.kind, sources: [], actions: [] };
    }
    answer = guarded.text;

    // An emergency reply is the configured text, word for word: the practice approves that
    // wording, and the model's own version only repeated it (seen in the agent evaluation).
    if (kind === "emergency") answer = this.settings.emergencyText;

    const keepSources = kind === "answered" || kind === "abstained" || kind === "declined_medical";
    return {
      answer,
      kind,
      sources: keepSources ? sources : [],
      actions: buildContactActions(actions, profile, answer),
    };
  }

  private fallback(
    reason: "abstained" | "refusal" | "unavailable",
    profile: ClinicProfile | null = null,
  ): { answer: string; kind: AnswerKind; sourceIds: string[]; actions: ActionType[] } {
    const whatsapp = profile?.contact.phone
      ? `por WhatsApp al ${localPhone(profile.contact.phone)}`
      : "por WhatsApp";
    switch (reason) {
      case "abstained":
        return {
          answer: `No encontré esa información en el sitio del Dr. Ghilino. Podés consultarlo ${whatsapp}.`,
          kind: "abstained",
          sourceIds: [],
          actions: ["whatsapp"],
        };
      case "refusal":
        return {
          answer:
            "No puedo ayudarte con eso. Puedo responder preguntas sobre los consultorios, los horarios, los turnos y el contacto del Dr. Ghilino.",
          kind: "out_of_scope",
          sourceIds: [],
          actions: [],
        };
      case "unavailable":
        return {
          answer: `No pude armar una respuesta en este momento. Probá de nuevo en un rato o escribí ${whatsapp}.`,
          kind: "abstained",
          sourceIds: [],
          actions: ["whatsapp"],
        };
    }
  }

  private async safeProfile(): Promise<ClinicProfile | null> {
    try {
      return await this.deps.clinic.activeProfile();
    } catch {
      return null;
    }
  }
}

function historyMessages(history: readonly ConversationTurn[], turns: number): LlmMessage[] {
  const recent = history.slice(-turns * 2);
  // The conversation must start with the visitor.
  const start = recent.findIndex((turn) => turn.role === "visitor");
  if (start === -1) return [];
  return recent.slice(start).map((turn) => ({
    role: turn.role === "visitor" ? "user" : "assistant",
    content: [{ type: "text", text: turn.text }],
  }));
}
