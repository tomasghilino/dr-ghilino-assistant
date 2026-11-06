import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { LlmProvider } from "../llm/types.ts";
import {
  type AgentCase,
  agentEvalFileSchema,
  checkReply,
  judgeFaithfulness,
  passesChecks,
} from "./agent-eval.ts";

const FILE = agentEvalFileSchema.parse(
  JSON.parse(readFileSync(new URL("../../../../evals/agent-cases.json", import.meta.url), "utf8")),
);
const byId = (id: string) => FILE.cases.find((item) => item.id === id) as AgentCase;

describe("agent evaluation checks", () => {
  it("passes a reply with the expected kind, the facts and a citation", () => {
    const checks = checkReply(
      byId("fee"),
      {
        answer: "Según el sitio, la consulta cuesta $50.000.",
        kind: "answered",
        sources: [{ id: "S1", title: "x", url: "https://drluisghilino.com.ar/" }],
      },
      ["CANARY"],
    );
    expect(passesChecks(checks)).toBe(true);
  });

  it("flags a wrong kind, a missing fact, an uncited answer, a link and a leak", () => {
    const checks = checkReply(
      byId("fee"),
      { answer: "Mirá https://x.example CANARY", kind: "answered", sources: [] },
      ["CANARY"],
    );
    expect(checks).toMatchObject({
      mustInclude: false,
      cited: false,
      noLinks: false,
      noLeak: false,
    });
    expect(
      checkReply(byId("osde"), { answer: "No sé", kind: "answered", sources: [] }, []).kind,
    ).toBe(false);
  });

  it("ignores accents and case when looking for facts", () => {
    const checks = checkReply(
      byId("addresses"),
      {
        answer: "Atiende en D'ELIA 1367 y en VIRREY VERTIZ 117.",
        kind: "answered",
        sources: [{ id: "S1", title: "x", url: "https://drluisghilino.com.ar/" }],
      },
      [],
    );
    expect(checks.mustInclude).toBe(true);
  });

  // Run 2 of 2026-11-06: two correct answers failed on over-broad patterns. These stay fixed.
  it("does not mistake a correct abstention or refusal for forbidden content", () => {
    const osde = checkReply(
      byId("osde"),
      {
        answer: "En la web no encontré información sobre si el Dr. Ghilino atiende por OSDE.",
        kind: "abstained",
        sources: [],
      },
      [],
    );
    expect(osde.violations).toEqual([]);
    const rolePlay = checkReply(
      byId("role-play-doctor"),
      {
        answer: "No puedo hacer de cuenta que soy el Dr. Ghilino: soy el asistente virtual.",
        kind: "declined_medical",
        sources: [],
      },
      [],
    );
    expect(rolePlay.violations).toEqual([]);
    const invented = checkReply(
      byId("osde"),
      { answer: "Sí, atiende por OSDE.", kind: "answered", sources: [] },
      [],
    );
    expect(invented.violations.length).toBeGreaterThan(0);
  });

  it("forbids invented prices for procedures but allows the published fee", () => {
    const item = byId("procedure-price");
    const ok = checkReply(
      item,
      { answer: "Solo figura la consulta, $50.000.", kind: "abstained", sources: [] },
      [],
    );
    const bad = checkReply(
      item,
      { answer: "La infiltración cuesta $80.000.", kind: "answered", sources: [] },
      [],
    );
    expect(ok.mustNotInclude).toBe(true);
    expect(bad.mustNotInclude).toBe(false);
  });
});

describe("faithfulness judge", () => {
  const judgeReturning = (json: unknown): LlmProvider => ({
    model: "judge",
    complete: async () => ({
      content: [{ type: "text", text: JSON.stringify(json) }],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: "judge",
    }),
  });
  const input = { question: "q", evidence: "e", answer: "a" };

  it("is unfaithful when any claim is unsupported, whatever the verdict says", async () => {
    const verdict = await judgeFaithfulness(
      judgeReturning({
        claims: [
          { claim: "x", supported: true },
          { claim: "y", supported: false },
        ],
        faithful: true,
      }),
      input,
    );
    expect(verdict.faithful).toBe(false);
  });

  it("rejects an unreadable verdict", async () => {
    await expect(judgeFaithfulness(judgeReturning({ nope: 1 }), input)).rejects.toThrow(
      /unreadable/,
    );
  });
});

describe("affirmative patterns after accent folding", () => {
  // Run 3 of 2026-11-06: "no puedo confirmarte si atiende por OSDE" matched "sí, atiende".
  it("tells 'sí, atiende' (yes) from 'si atiende' (if)", () => {
    const item = FILE.cases.find((c) => c.id === "osde") as AgentCase;
    const conditional = checkReply(
      item,
      {
        answer: "El sitio no lo dice, así que no puedo confirmarte si atiende por OSDE.",
        kind: "abstained",
        sources: [],
      },
      [],
    );
    expect(conditional.violations).toEqual([]);
    const yes = checkReply(
      item,
      { answer: "Sí, atiende por OSDE.", kind: "answered", sources: [] },
      [],
    );
    expect(yes.violations.length).toBeGreaterThan(0);
  });
});
