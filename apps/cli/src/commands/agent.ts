import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  type AgentCliConfig,
  agentCliConfigSchema,
  ChatService,
  createAssistant,
  InsforgeRpcClient,
  MemorySessionStore,
  type OutboundMessage,
  parseConfig,
} from "@ghilino/core";
import { createAdminClient } from "@insforge/sdk";

/**
 * Talk to the real agent from a terminal: Claude, Voyage and the InsForge knowledge base, with the
 * same pipeline the API uses (cleaning, emergency fast path, redaction, agent, guard). Sessions
 * live in memory and disappear when the command ends.
 */
function createChat(config: AgentCliConfig): ChatService {
  const rpc = new InsforgeRpcClient(
    createAdminClient({
      baseUrl: config.INSFORGE_BASE_URL,
      apiKey: config.INSFORGE_API_KEY,
      timeout: 15_000,
    }),
  );
  const { agent } = createAssistant(config, { rpc });
  return new ChatService(
    { agent, sessions: new MemorySessionStore() },
    {
      maxMessageChars: 800,
      historyTurns: config.AGENT_HISTORY_TURNS,
      emergencyText: config.SAFETY_EMERGENCY_TEXT,
      crisisText: config.SAFETY_CRISIS_TEXT,
      embeddingModel: config.EMBEDDINGS_MODEL,
    },
  );
}

const ASK_USAGE = `Usage: pnpm cli ask "<pregunta>" [--json]

  Sends one question through the full assistant (real Claude and Voyage calls; a few
  hundredths of a US cent each) and prints the answer, its sources and buttons, the tools the
  model used, tokens, cost and latency. --json prints the whole reply object.`;

export async function askCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const question = positionals.join(" ").trim();
  if (values.help || question === "") {
    console.log(ASK_USAGE);
    return values.help ? 0 : 1;
  }
  const chat = createChat(parseConfig(agentCliConfigSchema, process.env));
  const reply = await chat.handle({ channel: "web", conversationId: null, text: question });
  if (values.json) console.log(JSON.stringify(reply, null, 2));
  else printReply(reply);
  return 0;
}

export async function chatCommand(): Promise<number> {
  const chat = createChat(parseConfig(agentCliConfigSchema, process.env));
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  console.log(
    "Asistente del Dr. Ghilino (Ctrl+D o 'salir' para terminar, 'borrar' para empezar de nuevo)\n",
  );
  let conversationId: string | null = null;
  try {
    for (;;) {
      const line = (await terminal.question("vos> ").catch(() => null))?.trim();
      if (line === undefined || line === null || line === "salir") break;
      if (line === "") continue;
      if (line === "borrar") {
        if (conversationId) await chat.reset(conversationId);
        conversationId = null;
        console.log("(conversación borrada)\n");
        continue;
      }
      const reply = await chat.handle({ channel: "web", conversationId, text: line });
      conversationId = reply.conversationId;
      printReply(reply);
    }
  } finally {
    terminal.close();
  }
  return 0;
}

function printReply(reply: OutboundMessage): void {
  const t = reply.telemetry;
  console.log(`\nasistente> ${reply.answer}\n`);
  for (const source of reply.sources)
    console.log(`  fuente [${source.id}] ${source.title} — ${source.url}`);
  for (const action of reply.actions) console.log(`  botón  ${action.label} — ${action.url}`);
  const cost = t.estimatedCostUsd.toFixed(5);
  const tokens = `${t.usage.inputTokens} in + ${t.usage.cacheReadTokens} cached + ${t.usage.cacheWriteTokens} cache-write / ${t.usage.outputTokens} out`;
  console.log(
    `  [${reply.kind}${t.fastPath ? `, fast path ${t.fastPath}` : ""}] tools: ${t.toolCalls.join(", ") || "-"}; ${t.llmCalls} model calls; ${tokens}; ~US$${cost}; ${Math.round(t.latencyMs)} ms${t.flags.length > 0 ? `; flags: ${t.flags.join(", ")}` : ""}\n`,
  );
}
