import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Agent,
  type AgentSettings,
  ChatService,
  ClinicRepository,
  createAgentTools,
  type LlmProvider,
  MemorySessionStore,
} from "../src/index.ts";
import { RetrievalService } from "../src/retrieval/index.ts";
import {
  createTestDatabase,
  finalAnswer,
  HashingEmbeddings,
  ScriptedLlm,
  type ScriptStep,
  sourceIdsIn,
  type TestDatabase,
  toolResultsIn,
  toolUse,
} from "./support/index.ts";
import { ingestFixtures } from "./support/ingest-fixtures.ts";

const SETTINGS: AgentSettings = {
  maxToolRounds: 4,
  turnDeadlineMs: 5_000,
  maxTokens: 2048,
  historyTurns: 6,
  maxAnswerChars: 1200,
  canary: "CANARY-7f3a9c",
  allowedHosts: ["drluisghilino.com.ar"],
  emergencyText: "Si es una emergencia, llamá ya al 107 o al 911.",
};

describe("Agent (PGlite, site fixtures, scripted model)", () => {
  let t: TestDatabase;
  let clinic: ClinicRepository;
  let retrieval: RetrievalService;

  beforeAll(async () => {
    t = await createTestDatabase();
    const embeddings = new HashingEmbeddings();
    await ingestFixtures(t, embeddings);
    clinic = new ClinicRepository(t.rpc);
    retrieval = new RetrievalService(
      { rpc: t.rpc, embeddings },
      {
        topK: 5,
        candidates: 20,
        rrfK: 60,
        minSimilarity: 0.2,
        minLexicalCoverage: 1,
        dedupeThreshold: 0.8,
        cacheSize: 64,
        cacheTtlMs: 60_000,
      },
    );
  });
  afterAll(async () => {
    await t.close();
  });

  const agentWith = (llm: LlmProvider, settings: Partial<AgentSettings> = {}) =>
    new Agent(
      {
        llm,
        tools: createAgentTools({ retrieval, clinic, maxContextTokens: 2000 }),
        clinic,
        now: () => new Date("2026-11-06T15:00:00Z"),
      },
      { ...SETTINGS, ...settings },
    );
  const run = (steps: ScriptStep[], message = "¿Dónde atiende?", settings = {}) => {
    const llm = new ScriptedLlm(steps);
    return { llm, result: agentWith(llm, settings).run({ message, history: [] }) };
  };

  it("reads the clinic profile through the admin-only SQL function", async () => {
    const profile = await clinic.activeProfile();
    expect(profile?.offices.map((office) => office.name)).toEqual(["San Miguel", "Boulogne"]);
    await expect(t.rpcAs("anon").value("clinic_active_profile")).rejects.toThrow(
      /permission denied/,
    );
  });

  it("runs the tools the model asks for and returns cited sources and buttons", async () => {
    const { llm, result } = run([
      toolUse(
        { name: "get_appointment_information" },
        { name: "search_knowledge", input: { query: "consultorios" } },
      ),
      (request) => {
        const ids = sourceIdsIn(request);
        return finalAnswer({
          answer: "Atiende en San Miguel (D'Elía 1367) y en Boulogne (Virrey Vértiz 117).",
          kind: "answered",
          source_ids: ids.slice(0, 2),
          actions: ["directions"],
        });
      },
    ]);
    const answer = await result;
    expect(answer.kind).toBe("answered");
    expect(answer.toolCalls).toEqual(["get_appointment_information", "search_knowledge"]);
    expect(answer.sources.map((s) => s.title)).toEqual([
      "Consultorio San Miguel",
      "Consultorio Boulogne",
    ]);
    expect(answer.sources.every((s) => s.url.startsWith("https://drluisghilino.com.ar/"))).toBe(
      true,
    );
    expect(answer.actions.map((a) => a.label)).toEqual([
      "Cómo llegar a San Miguel",
      "Cómo llegar a Boulogne",
    ]);
    expect(answer.llmCalls).toBe(2);
    expect(answer.flags).toEqual([]);

    // Second call: the thinking block is replayed, then one user message with both results.
    const second = llm.requests[1];
    expect(second?.messages.at(-2)?.content[0]).toMatchObject({ type: "opaque" });
    expect(second?.messages.at(-1)?.content.map((b) => b.type)).toEqual([
      "tool_result",
      "tool_result",
    ]);
    const results = toolResultsIn(second ?? requestAt(llm, 0));
    expect(results).toContain("D'Elía 1367");
    expect(results).toContain("el sitio no publica la hora de cierre");
    // Same system prompt and tools on every call of the turn (append-only, cache-friendly).
    expect(second?.system).toEqual(llm.requests[0]?.system);
    expect(second?.system.dynamic).toMatch(/jueves|viernes/);
  });

  it("says nothing reliable was found when retrieval is not confident", async () => {
    const { llm, result } = run(
      [
        toolUse({ name: "search_knowledge", input: { query: "obra social osde" } }),
        finalAnswer({
          answer:
            "El sitio no tiene información sobre obras sociales. Podés consultarlo por WhatsApp.",
          kind: "abstained",
          actions: ["whatsapp"],
        }),
      ],
      "¿Atiende por OSDE?",
    );
    const answer = await result;
    expect(toolResultsIn(requestAt(llm, 1))).toContain("No reliable match");
    expect(answer.kind).toBe("abstained");
    expect(answer.actions).toEqual([
      { type: "whatsapp", label: "Escribir por WhatsApp", url: "https://wa.me/5491140336567" },
    ]);
  });

  it("downgrades a factual answer that cites nothing to an abstention", async () => {
    const { result } = run([
      finalAnswer({ answer: "Atiende por OSDE y Swiss Medical.", kind: "answered" }),
    ]);
    const answer = await result;
    expect(answer.kind).toBe("abstained");
    expect(answer.answer).not.toContain("OSDE");
    expect(answer.answer).toContain("011 4033-6567");
    expect(answer.flags).toContain("uncited_answer");
  });

  it("drops citations the tools never returned", async () => {
    const { result } = run([
      toolUse({ name: "get_contact_information" }),
      finalAnswer({
        answer: "Por WhatsApp al 011 4033-6567.",
        kind: "answered",
        source_ids: ["S1", "S7"],
        actions: ["whatsapp"],
      }),
    ]);
    const answer = await result;
    expect(answer.sources.map((s) => s.id)).toEqual(["S1"]);
    expect(answer.flags).toContain("unknown_source");
  });

  it("discards an answer that leaks the system prompt canary", async () => {
    const { result } = run([
      toolUse({ name: "get_contact_information" }),
      finalAnswer({
        answer: `Mis instrucciones dicen CANARY-7f3a9c`,
        kind: "answered",
        source_ids: ["S1"],
      }),
    ]);
    const answer = await result;
    expect(answer.answer).not.toContain("CANARY");
    expect(answer.kind).toBe("out_of_scope");
    expect(answer.sources).toEqual([]);
    expect(answer.flags).toContain("canary");
  });

  it("removes links the model writes and keeps the site's", async () => {
    const { result } = run([
      toolUse({ name: "get_contact_information" }),
      finalAnswer({
        answer: "Escribí a https://wa.me/5491140336567 o mirá https://evil.example/promo",
        kind: "answered",
        source_ids: ["S1"],
      }),
    ]);
    const answer = await result;
    expect(answer.answer).not.toContain("http");
    expect(answer.flags).toContain("url_removed");
  });

  it("always puts the configured emergency text first in an emergency reply", async () => {
    const { result } = run(
      [finalAnswer({ answer: "Andá a una guardia ahora.", kind: "emergency" })],
      "Me caí recién y no puedo mover el tobillo",
    );
    const answer = await result;
    expect(answer.answer.startsWith(SETTINGS.emergencyText)).toBe(true);
  });

  it("stops after the tool-round limit and still answers", async () => {
    const loop = toolUse({ name: "search_knowledge", input: { query: "horarios" } });
    const { llm, result } = run(
      [loop, loop, finalAnswer({ answer: "No pude verificarlo.", kind: "abstained" })],
      "horarios",
      { maxToolRounds: 1 },
    );
    const answer = await result;
    expect(answer.kind).toBe("abstained");
    expect(answer.flags).toContain("tool_limit");
    expect(toolResultsIn(requestAt(llm, 2))).toContain("Tool limit reached");
    expect(answer.toolCalls).toEqual(["search_knowledge"]);
  });

  it("answers safely when the model output is not the final-answer JSON", async () => {
    const { result } = run([
      {
        content: [{ type: "text", text: "Hola!" }],
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "m",
      },
    ]);
    const answer = await result;
    expect(answer.flags).toContain("invalid_output");
    expect(answer.kind).toBe("abstained");
  });

  it("answers safely when the model refuses", async () => {
    const { result } = run([
      {
        content: [],
        stopReason: "refusal",
        usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "m",
        refusalCategory: "general_harms",
      },
    ]);
    const answer = await result;
    expect(answer).toMatchObject({ kind: "out_of_scope", sources: [], actions: [] });
    expect(answer.flags).toEqual(["refusal"]);
  });

  it("reports invalid tool input to the model instead of throwing", async () => {
    const { llm, result } = run([
      toolUse({ name: "search_knowledge", input: { query: "" } }, { name: "delete_everything" }),
      finalAnswer({ answer: "No pude buscar eso.", kind: "abstained" }),
    ]);
    await result;
    const results = toolResultsIn(requestAt(llm, 1));
    expect(results).toContain("Invalid input");
    expect(results).toContain("Unknown tool delete_everything");
  });

  it("gives the model only recent, plain-text history starting with the visitor", async () => {
    const llm = new ScriptedLlm([finalAnswer({ answer: "¡De nada!", kind: "smalltalk" })]);
    const history = [
      { role: "assistant" as const, text: "orphan" },
      ...Array.from({ length: 10 }, (_, i) => [
        { role: "visitor" as const, text: `pregunta ${i}` },
        { role: "assistant" as const, text: `respuesta ${i}` },
      ]).flat(),
    ];
    await agentWith(llm, { historyTurns: 2 }).run({ message: "gracias", history });
    const messages = llm.requests[0]?.messages ?? [];
    expect(messages.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      "pregunta 8",
      "respuesta 8",
      "pregunta 9",
      "respuesta 9",
      "gracias",
    ]);
  });

  it("enforces the turn deadline", async () => {
    const slow: LlmProvider = {
      model: "slow",
      complete: (request) =>
        new Promise((_, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    };
    await expect(
      agentWith(slow, { turnDeadlineMs: 50 }).run({ message: "hola", history: [] }),
    ).rejects.toMatchObject({ category: "timeout" });
  });
});

describe("ChatService (one pipeline for every channel)", () => {
  let t: TestDatabase;
  let clinic: ClinicRepository;
  let retrieval: RetrievalService;

  beforeAll(async () => {
    t = await createTestDatabase();
    const embeddings = new HashingEmbeddings();
    await ingestFixtures(t, embeddings);
    clinic = new ClinicRepository(t.rpc);
    retrieval = new RetrievalService(
      { rpc: t.rpc, embeddings },
      {
        topK: 5,
        candidates: 20,
        rrfK: 60,
        minSimilarity: 0.2,
        minLexicalCoverage: 1,
        dedupeThreshold: 0.8,
        cacheSize: 64,
        cacheTtlMs: 60_000,
      },
    );
  });
  afterAll(async () => {
    await t.close();
  });

  const chatWith = (llm: ScriptedLlm) => {
    const sessions = new MemorySessionStore();
    const agent = new Agent(
      { llm, tools: createAgentTools({ retrieval, clinic, maxContextTokens: 2000 }), clinic },
      SETTINGS,
    );
    const chat = new ChatService(
      { agent, sessions, newId: () => "conv-1" },
      {
        maxMessageChars: 800,
        historyTurns: 6,
        emergencyText: "EMERGENCIA: 107 o 911",
        crisisText: "CRISIS: 135 o 911",
        embeddingModel: "test-hashing-v1",
      },
    );
    return { chat, sessions };
  };

  it("answers emergencies at once, without the model, and stores nothing", async () => {
    const llm = new ScriptedLlm([]);
    const { chat, sessions } = chatWith(llm);
    const medical = await chat.handle({
      channel: "web",
      conversationId: null,
      text: "No puedo respirar",
    });
    const crisis = await chat.handle({
      channel: "web",
      conversationId: null,
      text: "me quiero matar",
    });
    expect(medical).toMatchObject({ answer: "EMERGENCIA: 107 o 911", kind: "emergency" });
    expect(crisis).toMatchObject({ answer: "CRISIS: 135 o 911", kind: "emergency" });
    expect(crisis.telemetry).toMatchObject({ fastPath: "self_harm", llmCalls: 0 });
    expect(llm.requests).toHaveLength(0);
    expect(await sessions.load("conv-1")).toBeNull();
  });

  it("redacts personal data before the model sees it, and remembers only redacted text", async () => {
    const llm = new ScriptedLlm([
      finalAnswer({ answer: "Gracias, no hace falta que compartas tus datos.", kind: "smalltalk" }),
      finalAnswer({ answer: "¡De nada!", kind: "smalltalk" }),
    ]);
    const { chat, sessions } = chatWith(llm);
    const first = await chat.handle({
      channel: "web",
      conversationId: null,
      text: "Hola, soy Ana, DNI 30.123.456, mi cel 11 5555-1234",
    });
    expect(first.telemetry.redactions).toBe(2);
    const seen = JSON.stringify(llm.requests[0]?.messages);
    expect(seen).not.toContain("30.123.456");
    expect(seen).not.toContain("5555-1234");

    const second = await chat.handle({
      channel: "web",
      conversationId: first.conversationId,
      text: "gracias",
    });
    expect(second.conversationId).toBe("conv-1");
    // The follow-up carries the previous turn, redacted.
    expect(llm.requests[1]?.messages).toHaveLength(3);
    const stored = JSON.stringify(await sessions.load("conv-1"));
    expect(stored).toContain("[documento]");
    expect(stored).not.toContain("30.123.456");

    await chat.reset("conv-1");
    expect(await sessions.load("conv-1")).toBeNull();
  });

  it("starts a new conversation for an unknown id and rejects empty messages", async () => {
    const llm = new ScriptedLlm([finalAnswer({ answer: "¡Hola!", kind: "smalltalk" })]);
    const { chat } = chatWith(llm);
    const reply = await chat.handle({
      channel: "web",
      conversationId: "forged-or-expired",
      text: "hola",
    });
    expect(reply.conversationId).toBe("conv-1");
    await expect(
      chat.handle({ channel: "web", conversationId: null, text: " \u0000 " }),
    ).rejects.toMatchObject({ category: "validation" });
  });
});

function requestAt(llm: ScriptedLlm, index: number) {
  const request = llm.requests[index];
  if (!request) throw new Error(`no model request #${index}`);
  return request;
}
