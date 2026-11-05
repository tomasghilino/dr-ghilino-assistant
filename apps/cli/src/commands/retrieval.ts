import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  assembleContext,
  createEmbeddingProvider,
  InsforgeRpcClient,
  parseConfig,
  type RetrievalCliConfig,
  RetrievalService,
  retrievalCliConfigSchema,
  retrievalSettingsFrom,
} from "@ghilino/core";
import {
  RANKING_MODES,
  type RetrievalEvalReport,
  retrievalEvalFileSchema,
  runRetrievalEval,
  thresholdRange,
} from "@ghilino/core/evaluation";
import { createAdminClient } from "@insforge/sdk";

function createService(config: RetrievalCliConfig): RetrievalService {
  const rpc = new InsforgeRpcClient(
    createAdminClient({
      baseUrl: config.INSFORGE_BASE_URL,
      apiKey: config.INSFORGE_API_KEY,
      timeout: 15_000,
    }),
  );
  return new RetrievalService(
    { rpc, embeddings: createEmbeddingProvider(config) },
    retrievalSettingsFrom(config),
  );
}

const SEARCH_USAGE = `Usage: pnpm cli search "<question>" [--top <k>] [--source <id>]... [--context]

  Shows how the knowledge base ranks a question: semantic and lexical ranks, the fused RRF
  score, the confidence gate, and (with --context) the exact text the model would read.
  One embeddings call (a few dozen tokens) and one database call. Nothing is stored.`;

export async function searchCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      top: { type: "string" },
      source: { type: "string", multiple: true },
      context: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const query = positionals.join(" ").trim();
  if (values.help || query === "") {
    console.log(SEARCH_USAGE);
    return values.help ? 0 : 1;
  }
  const config = parseConfig(retrievalCliConfigSchema, process.env);
  const service = createService(config);
  const topK = values.top ? Number.parseInt(values.top, 10) : config.RETRIEVAL_TOP_K;
  const result = await service.search({
    query,
    topK,
    ...(values.source ? { sourceIds: values.source } : {}),
  });

  const verdict = result.confident ? `answer (gate passed: ${result.gate})` : "ABSTAIN";
  console.log(
    `\n${verdict}: best similarity ${fmt(result.bestSimilarity)} (threshold ${result.minSimilarity}), best lexical coverage ${fmt(result.bestLexicalCoverage)} (needs ${config.RETRIEVAL_MIN_LEXICAL_COVERAGE})`,
  );
  console.log(
    `embed ${result.timings.embedMs.toFixed(0)} ms, search ${result.timings.searchMs.toFixed(0)} ms, ${result.usage.embeddingTokens} embedding tokens, ${result.droppedNearDuplicates} near-duplicates dropped\n`,
  );
  console.log("  #  sem (sim)      lex (cov)       rrf      chunk");
  result.chunks.forEach((chunk, index) => {
    const semantic = chunk.semanticRank
      ? `${String(chunk.semanticRank).padStart(2)} (${fmt(chunk.similarity)})`
      : " -        ";
    const lexical = chunk.lexicalRank
      ? `${String(chunk.lexicalRank).padStart(2)} (${fmt(chunk.lexicalCoverage)})`
      : " -        ";
    console.log(
      `  ${index + 1}  ${semantic}   ${lexical}   ${chunk.rrfScore.toFixed(4)}   ${chunk.headingPath.join(" › ")}`,
    );
    const body = chunk.content.split("\n").slice(1).join(" ");
    console.log(
      `                                   ${body.slice(0, 110)}${body.length > 110 ? "…" : ""}`,
    );
  });
  if (values.context) {
    const context = assembleContext(result.chunks, config.RETRIEVAL_MAX_CONTEXT_TOKENS);
    console.log(
      `\nContext for the model (${context.tokens} estimated tokens, ${context.omitted} omitted):\n`,
    );
    console.log(context.text);
  }
  return 0;
}

const EVAL_USAGE = `Usage: pnpm cli eval:retrieval [--cases <file>] [--out <dir>] [--no-save]

  Runs every question in the dataset against the live knowledge base and compares semantic,
  lexical, hybrid and service rankings (Hit@K, Recall@K, MRR), then sweeps the confidence
  threshold. All questions are embedded in one call. The JSON report (chunk keys, scores and
  similarities; no chunk content) is written to evals/reports/.`;

export async function evalRetrievalCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cases: { type: "string", default: "evals/retrieval-cases.json" },
      out: { type: "string", default: "evals/reports" },
      "no-save": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(EVAL_USAGE);
    return 0;
  }
  const file = retrievalEvalFileSchema.parse(JSON.parse(readFileSync(values.cases, "utf8")));
  const config = parseConfig(retrievalCliConfigSchema, process.env);
  const settings = retrievalSettingsFrom(config);
  const report = await runRetrievalEval(createService(config), file, {
    ks: [1, 3, 5],
    mrrCutoff: 10,
    thresholds: thresholdRange(0.15, 0.7, 0.01),
    settings,
  });
  printEvalReport(report);
  if (!values["no-save"]) {
    mkdirSync(values.out, { recursive: true });
    const path = join(values.out, `retrieval-${report.generatedAt.slice(0, 10)}.json`);
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nReport written to ${path}`);
  }
  return report.unseenAliases.length === 0 ? 0 : 1;
}

function printEvalReport(report: RetrievalEvalReport): void {
  const pct = (value: number | undefined) => `${((value ?? 0) * 100).toFixed(1)}%`.padStart(7);
  console.log(
    `\nRetrieval evaluation: ${report.dataset.cases} cases (${report.dataset.scoredCases} with relevant chunks), model ${report.embeddingModel}`,
  );
  console.log("\n  mode        Hit@1   Hit@3   Hit@5   Recall@5  MRR@10");
  for (const mode of RANKING_MODES) {
    const m = report.metrics[mode];
    console.log(
      `  ${mode.padEnd(9)} ${pct(m.hitAt[1])} ${pct(m.hitAt[3])} ${pct(m.hitAt[5])}  ${pct(m.recallAt[5])}   ${m.mrr.toFixed(3)}`,
    );
  }
  console.log("\n  service mode by category   cases  Hit@5    Recall@5  MRR@10");
  for (const [category, perMode] of Object.entries(report.byCategory)) {
    const m = perMode.service;
    console.log(
      `  ${category.padEnd(26)} ${String(m.cases).padStart(4)} ${pct(m.hitAt[5])}  ${pct(m.recallAt[5])}   ${m.mrr.toFixed(3)}`,
    );
  }
  for (const [label, gate] of [
    ["semantic only", report.gate.semanticOnly],
    [
      `semantic or lexical coverage ≥ ${report.settings.minLexicalCoverage}`,
      report.gate.semanticOrLexical,
    ],
  ] as const) {
    const { current, recommended } = gate;
    console.log(
      `\nGate, ${label}, at ${current.threshold}: ${current.falseAbstentions}/${current.answerable} answerable questions abstained, ${current.falseConfidence}/${current.unanswerable} unanswerable ones passed`,
    );
    if (recommended) {
      console.log(
        `  recommended interval ${recommended.from}–${recommended.to} (midpoint ${recommended.midpoint.toFixed(3)}): ${recommended.falseAbstentions} false abstentions, ${recommended.falseConfidence} false confidences`,
      );
    }
  }
  console.log("\nSignals per gated case (similarity, lexical coverage), highest similarity first:");
  for (const item of report.gate.signals) {
    const marker = item.expect === "answer" ? "answer " : "abstain";
    console.log(
      `  ${fmt(item.bestSimilarity)}  ${fmt(item.bestLexicalCoverage)}  ${marker}  ${item.id}`,
    );
  }
  const misses = report.cases.filter((item) => item.scored && item.recallAtMaxK.service < 1);
  if (misses.length > 0) {
    console.log("\nCases where the service missed a requirement in the top 5:");
    for (const item of misses) {
      console.log(
        `  ${item.id}: recall ${pct(item.recallAtMaxK.service)}, first relevant at ${item.firstRelevantRank.service ?? "-"}; top: ${item.top.service.slice(0, 3).join(" | ")}`,
      );
    }
  }
  console.log(
    `\nLatency (ms): search p50 ${report.latencyMs.search.p50.toFixed(0)} p95 ${report.latencyMs.search.p95.toFixed(0)}; service p50 ${report.latencyMs.service.p50.toFixed(0)} p95 ${report.latencyMs.service.p95.toFixed(0)}`,
  );
  console.log(
    `Embedding tokens: ${report.usage.embeddingTokens} for ${report.usage.queriesEmbedded} questions; cache misses during search: ${report.usage.serviceCacheMisses}`,
  );
  if (report.unseenAliases.length > 0) {
    console.log(
      `\nAliases never retrieved (check the dataset): ${report.unseenAliases.join(", ")}`,
    );
  }
}

function fmt(value: number | null): string {
  return value === null ? "  -  " : value.toFixed(3);
}
