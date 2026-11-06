import type { AgentCliConfig } from "../config/env.ts";
import type { RpcClient } from "../db/rpc.ts";
import { createEmbeddingProvider } from "../embeddings/factory.ts";
import { AnthropicProvider } from "../llm/anthropic.ts";
import type { LlmProvider } from "../llm/types.ts";
import { RetrievalService, retrievalSettingsFrom } from "../retrieval/service.ts";
import { Agent, type AgentSettings } from "./agent.ts";
import { ClinicRepository } from "./clinic.ts";
import { createAgentTools } from "./tools.ts";

/** Hosts an answer's text may link to. Answers should contain no links at all (ADR 0006). */
export const ANSWER_LINK_HOSTS = ["drluisghilino.com.ar"] as const;

export interface Assistant {
  agent: Agent;
  retrieval: RetrievalService;
  clinic: ClinicRepository;
  llm: LlmProvider;
  settings: AgentSettings;
}

/**
 * Wire the agent from configuration: Claude, Voyage, the database. Used by the CLI and the API
 * entry points (the composition roots); tests build the pieces themselves with stand-ins.
 */
export function createAssistant(
  config: AgentCliConfig,
  deps: { rpc: RpcClient; llm?: LlmProvider; fetch?: typeof fetch },
): Assistant {
  const embeddings = createEmbeddingProvider(config, deps.fetch ? { fetch: deps.fetch } : {});
  const retrieval = new RetrievalService(
    { rpc: deps.rpc, embeddings },
    retrievalSettingsFrom(config),
  );
  const clinic = new ClinicRepository(deps.rpc);
  const llm =
    deps.llm ??
    new AnthropicProvider({
      apiKey: config.ANTHROPIC_API_KEY,
      model: config.LLM_MODEL,
      effort: config.LLM_EFFORT,
      timeoutMs: config.LLM_TIMEOUT_MS,
      maxRetries: config.LLM_MAX_RETRIES,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
  const settings: AgentSettings = {
    maxToolRounds: config.AGENT_MAX_TOOL_ROUNDS,
    turnDeadlineMs: config.TURN_DEADLINE_MS,
    maxTokens: config.LLM_MAX_TOKENS,
    historyTurns: config.AGENT_HISTORY_TURNS,
    maxAnswerChars: 1_200,
    canary: config.SAFETY_PROMPT_CANARY ?? randomCanary(),
    allowedHosts: [...ANSWER_LINK_HOSTS],
    emergencyText: config.SAFETY_EMERGENCY_TEXT,
  };
  const tools = createAgentTools({
    retrieval,
    clinic,
    maxContextTokens: config.RETRIEVAL_MAX_CONTEXT_TOKENS,
  });
  return { agent: new Agent({ llm, tools, clinic }, settings), retrieval, clinic, llm, settings };
}

/**
 * Fallback when SAFETY_PROMPT_CANARY is unset: a random code per process. It stays the same for
 * every request this instance serves, so its cached system prompt stays valid; each new instance
 * writes its own cache entry (cache writes cost 1.25× input), hence the configured secret.
 */
function randomCanary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `GHL-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
