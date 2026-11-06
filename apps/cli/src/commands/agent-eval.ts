import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  AnthropicProvider,
  addUsage,
  agentCliConfigSchema,
  ChatService,
  createAssistant,
  createEmbeddingProvider,
  estimateLlmCostUsd,
  InsforgeRpcClient,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmUsage,
  MemorySessionStore,
  type OutboundMessage,
  type PinnedSource,
  parseConfig,
  RetrievalService,
  retrievalSettingsFrom,
  sourceBlock,
  websiteFromChunks,
  ZERO_USAGE,
} from "@ghilino/core";
import {
  type AgentCase,
  type AgentEvalCaseResult,
  agentEvalFileSchema,
  checkReply,
  judgeFaithfulness,
  passesChecks,
  RecordingLlm,
  summarizeAgentEval,
} from "@ghilino/core/evaluation";
import { createAdminClient } from "@insforge/sdk";

const USAGE = `Usage: pnpm cli eval:agent [--effort low|medium|high] [--judge-model <id>] [--no-judge]
                           [--knowledge retrieval|full-context]
                           [--only id,id] [--concurrency 3] [--cases <file>] [--out <dir>]

  Runs every conversation in evals/agent-cases.json through the real assistant (Claude, Voyage,
  InsForge; memory-only sessions), checks each final reply, and has a judge model grade the
  faithfulness of factual answers against the tool results. Prints a summary and writes a JSON
  report with the answers to evals/reports/. Costs well under one US dollar.

  --knowledge full-context puts the whole indexed site in the system prompt and removes the
  search tool: the baseline that retrieval is compared with in docs/evaluation.md.`;

/** Counts a provider's spend. */
class CostMeter implements LlmProvider {
  costUsd = 0;
  constructor(private readonly inner: LlmProvider) {}
  get model(): string {
    return this.inner.model;
  }
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.inner.complete(request);
    this.costUsd += estimateLlmCostUsd(response.model, response.usage) ?? 0;
    return response;
  }
}

export async function evalAgentCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      effort: { type: "string" },
      knowledge: { type: "string", default: "retrieval" },
      "judge-model": { type: "string", default: "claude-sonnet-5-5" },
      "no-judge": { type: "boolean", default: false },
      only: { type: "string" },
      concurrency: { type: "string", default: "3" },
      cases: { type: "string", default: "evals/agent-cases.json" },
      out: { type: "string", default: "evals/reports" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const config = parseConfig(agentCliConfigSchema, {
    ...process.env,
    ...(values.effort ? { LLM_EFFORT: values.effort } : {}),
  });
  const knowledge = values.knowledge;
  if (knowledge !== "retrieval" && knowledge !== "full-context") {
    console.error(`--knowledge must be "retrieval" or "full-context"\n\n${USAGE}`);
    return 2;
  }
  // One canary for the whole run, as in production, where SAFETY_PROMPT_CANARY is set. A random
  // canary per conversation would change the system prompt every time and defeat the prompt
  // cache, which made the first full-context run look more expensive than it is.
  const runConfig = {
    ...config,
    SAFETY_PROMPT_CANARY: config.SAFETY_PROMPT_CANARY ?? `EVAL-${randomUUID().slice(0, 8)}`,
  };
  const file = agentEvalFileSchema.parse(JSON.parse(readFileSync(values.cases, "utf8")));
  const only = values.only ? new Set(values.only.split(",")) : null;
  const cases = file.cases.filter((item) => !only || only.has(item.id));

  const rpc = new InsforgeRpcClient(
    createAdminClient({
      baseUrl: config.INSFORGE_BASE_URL,
      apiKey: config.INSFORGE_API_KEY,
      timeout: 15_000,
    }),
  );
  const embeddings = createEmbeddingProvider(config);
  const website =
    knowledge === "full-context"
      ? await loadWebsite(new RetrievalService({ rpc, embeddings }, retrievalSettingsFrom(config)))
      : [];
  // In the baseline the site is in the prompt, so the judge gets it as evidence too.
  const websiteEvidence = website
    .map((source, index) => sourceBlock(`S${index + 1}`, source.title, source.url, source.content))
    .join("\n\n");
  const agentLlm = new AnthropicProvider({
    apiKey: config.ANTHROPIC_API_KEY,
    model: config.LLM_MODEL,
    effort: config.LLM_EFFORT,
    timeoutMs: config.LLM_TIMEOUT_MS,
    maxRetries: config.LLM_MAX_RETRIES,
  });
  const judge = values["no-judge"]
    ? null
    : new CostMeter(
        new AnthropicProvider({
          apiKey: config.ANTHROPIC_API_KEY,
          model: values["judge-model"],
          effort: "medium",
          timeoutMs: 60_000,
          maxRetries: 2,
        }),
      );

  const runCase = async (item: AgentCase): Promise<AgentEvalCaseResult> => {
    const recorder = new RecordingLlm(agentLlm);
    const assistant = createAssistant(runConfig, {
      rpc,
      llm: recorder,
      embeddings,
      ...(website.length > 0 ? { website } : {}),
    });
    const chat = new ChatService(
      { agent: assistant.agent, sessions: new MemorySessionStore() },
      {
        maxMessageChars: 800,
        historyTurns: config.AGENT_HISTORY_TURNS,
        emergencyText: config.SAFETY_EMERGENCY_TEXT,
        crisisText: config.SAFETY_CRISIS_TEXT,
        embeddingModel: config.EMBEDDINGS_MODEL,
      },
    );
    let reply: OutboundMessage | null = null;
    let conversationId: string | null = null;
    let costUsd = 0;
    let usage: LlmUsage = ZERO_USAGE;
    try {
      for (const text of item.turns) {
        reply = await chat.handle({ channel: "web", conversationId, text });
        conversationId = reply.conversationId;
        costUsd += reply.telemetry.estimatedCostUsd;
        usage = addUsage(usage, reply.telemetry.usage);
      }
    } catch (error) {
      return failed(item, (error as Error).message, costUsd);
    }
    if (!reply) return failed(item, "no reply", costUsd);
    const checks = checkReply(item, reply, [assistant.settings.canary]);
    const result: AgentEvalCaseResult = {
      id: item.id,
      category: item.category,
      turns: item.turns,
      answer: reply.answer,
      kind: reply.kind,
      expectKinds: item.expectKinds,
      sources: reply.sources.map((source) => source.title),
      toolCalls: reply.telemetry.toolCalls,
      checks,
      passed: passesChecks(checks),
      judge: null,
      latencyMs: Math.round(reply.telemetry.latencyMs),
      costUsd,
      usage,
      flags: reply.telemetry.flags,
    };
    if (judge && reply.kind === "answered") {
      try {
        result.judge = await judgeFaithfulness(judge, {
          question: item.turns.at(-1) ?? "",
          evidence: [websiteEvidence, recorder.lastTurnEvidence()].filter(Boolean).join("\n\n"),
          answer: reply.answer,
        });
        if (!result.judge.faithful) result.passed = false;
      } catch (error) {
        result.judgeError = (error as Error).message;
      }
    }
    process.stdout.write(result.passed ? "." : "x");
    return result;
  };

  const started = Date.now();
  const results = await mapWithConcurrency(cases, Number(values.concurrency) || 3, runCase);
  process.stdout.write("\n");
  const summary = summarizeAgentEval(results);
  const report = {
    generatedAt: new Date().toISOString(),
    model: config.LLM_MODEL,
    effort: config.LLM_EFFORT,
    knowledge,
    websiteChunks: website.length,
    judgeModel: judge?.model ?? null,
    judgeCostUsd: judge?.costUsd ?? 0,
    durationMs: Date.now() - started,
    summary,
    results,
  };
  printSummary(report);
  mkdirSync(values.out, { recursive: true });
  // Never overwrite an earlier run of the same day: the second becomes -run2, and so on.
  const base = `agent-${report.generatedAt.slice(0, 10)}-${config.LLM_EFFORT}${knowledge === "full-context" ? "-full-context" : ""}${only ? "-partial" : ""}`;
  let path = join(values.out, `${base}.json`);
  for (let run = 2; existsSync(path); run++) path = join(values.out, `${base}-run${run}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nReport written to ${path}`);
  return summary.errors === 0 ? 0 : 1;
}

/**
 * Every published chunk, for the full-context baseline. There is no "list chunks" function on
 * purpose (the API never needs one), so this asks hybrid search for more rows than exist: every
 * chunk is a semantic candidate, whatever the query.
 */
async function loadWebsite(retrieval: RetrievalService): Promise<PinnedSource[]> {
  const query = "Dr. Luis Antonio Ghilino";
  const { vectors } = await retrieval.embedQueries([query]);
  const rows = await retrieval.searchByVector(vectors[0] ?? [], query, {
    matchCount: 500,
    candidates: 500,
  });
  return websiteFromChunks(
    rows.map((row) => ({
      url: row.anchor_url,
      headingPath: row.heading_path,
      title: row.document_title,
      content: row.content,
    })),
  );
}

function failed(item: AgentCase, error: string, costUsd: number): AgentEvalCaseResult {
  process.stdout.write("E");
  return {
    id: item.id,
    category: item.category,
    turns: item.turns,
    answer: "",
    kind: "error",
    expectKinds: item.expectKinds,
    sources: [],
    toolCalls: [],
    checks: {
      kind: false,
      mustInclude: false,
      missing: [],
      mustNotInclude: true,
      violations: [],
      noLinks: true,
      cited: true,
      noLeak: true,
    },
    passed: false,
    judge: null,
    latencyMs: 0,
    costUsd,
    flags: [],
    error,
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index] as T);
      }
    }),
  );
  return results;
}

function printSummary(report: {
  model: string;
  effort: string;
  knowledge: string;
  websiteChunks: number;
  judgeModel: string | null;
  judgeCostUsd: number;
  summary: ReturnType<typeof summarizeAgentEval>;
  results: AgentEvalCaseResult[];
}): void {
  const s = report.summary;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  console.log(
    `\nAgent evaluation: ${report.model}, effort ${report.effort}, judge ${report.judgeModel ?? "off"}, knowledge ${report.knowledge}${report.websiteChunks > 0 ? ` (${report.websiteChunks} chunks in the prompt)` : ""}`,
  );
  console.log(`  passed            ${s.passed}/${s.cases} (errors: ${s.errors})`);
  console.log(`  answer kind       ${pct(s.kindAccuracy)} as expected`);
  console.log(`  required facts    ${pct(s.mustIncludeRate)} present`);
  console.log(`  faithful          ${s.faithful}/${s.judged} judged answers`);
  console.log(
    `  forbidden content ${s.forbiddenViolations}, uncited answers ${s.uncitedAnswers}, links in text ${s.linkLeaks}, prompt leaks ${s.promptLeaks}`,
  );
  console.log(
    `  latency (ms)      p50 ${Math.round(s.latencyMs.p50)}, p95 ${Math.round(s.latencyMs.p95)}, max ${Math.round(s.latencyMs.max)}`,
  );
  console.log(
    `  cost (US$)        assistant ${s.costUsd.total.toFixed(4)} (${s.costUsd.perMessage.toFixed(5)} per conversation), judge ${report.judgeCostUsd.toFixed(4)}`,
  );
  console.log(
    `  tokens            input ${s.usage.inputTokens}, cache read ${s.usage.cacheReadTokens}, cache write ${s.usage.cacheWriteTokens}, output ${s.usage.outputTokens}`,
  );
  console.log(
    `  tools             ${Object.entries(s.toolCalls)
      .map(([name, n]) => `${name} ${n}`)
      .join(", ")}`,
  );
  console.log("\n  by category");
  for (const [category, entry] of Object.entries(s.byCategory)) {
    console.log(`    ${category.padEnd(13)} ${entry.passed}/${entry.cases}`);
  }
  const failures = report.results.filter((result) => !result.passed);
  if (failures.length > 0) {
    console.log("\n  failures");
    for (const result of failures) {
      const reasons = [
        result.error ? `error: ${result.error}` : null,
        !result.checks.kind
          ? `kind ${result.kind} (expected ${result.expectKinds.join("|")})`
          : null,
        result.checks.missing.length > 0
          ? `missing ${result.checks.missing.map((g) => g.join("|")).join(", ")}`
          : null,
        result.checks.violations.length > 0
          ? `forbidden /${result.checks.violations.join("/, /")}/`
          : null,
        !result.checks.cited ? "uncited" : null,
        !result.checks.noLinks ? "link in text" : null,
        !result.checks.noLeak ? "prompt leak" : null,
        result.judge && !result.judge.faithful
          ? `unsupported: ${result.judge.claims
              .filter((c) => !c.supported)
              .map((c) => c.claim)
              .join("; ")}`
          : null,
      ].filter(Boolean);
      console.log(`    ${result.id}: ${reasons.join("; ")}`);
      console.log(`      → ${result.answer.replace(/\s+/g, " ").slice(0, 220)}`);
    }
  }
}
