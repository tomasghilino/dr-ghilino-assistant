import {
  createTestDatabase,
  finalAnswer,
  HashingEmbeddings,
  ingestFixtures,
  ScriptedLlm,
  type ScriptStep,
  sourceIdsIn,
  type TestDatabase,
  toolUse,
} from "@ghilino/core/testing";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAppFromEnv } from "../src/compose.ts";

const ORIGIN = "https://drluisghilino.com.ar";
const MAINTENANCE_TOKEN = "m".repeat(40);

const ENV = {
  APP_ENV: "test",
  ANTHROPIC_API_KEY: "sk-ant-test",
  VOYAGE_API_KEY: "pa-test",
  INSFORGE_BASE_URL: "https://example.us-east.insforge.app",
  INSFORGE_API_KEY: "ik_test",
  RATE_LIMIT_SALT: "0123456789abcdef0123",
  RATE_LIMIT_PER_MINUTE: "100",
  RATE_LIMIT_PER_DAY: "1000",
  SESSION_ENCRYPTION_KEY: btoa("k".repeat(32)),
  RETRIEVAL_MIN_SIMILARITY: "0.2",
  ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`,
  MAINTENANCE_TOKEN,
  SAFETY_PROMPT_CANARY: "CANARY-test-1234",
};

describe("HTTP API (PGlite, site fixtures, scripted model)", () => {
  let t: TestDatabase;
  let steps: ScriptStep[];
  let llm: ScriptedLlm;
  let app: Hono;
  const logs: Array<Record<string, unknown>> = [];

  const build = async (env: Record<string, string> = {}) => {
    steps = [];
    llm = new ScriptedLlm(steps);
    return createAppFromEnv(
      { ...ENV, ...env },
      {
        version: "test",
        rpc: t.rpc,
        llm,
        embeddings: new HashingEmbeddings(),
        log: (e) => logs.push(e),
      },
    );
  };
  const post = (body: unknown, headers: Record<string, string> = {}, target = app) =>
    target.request("/v1/chat", {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.7",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const metrics = () =>
    t.db
      .query<Record<string, unknown>>("select * from public.request_metrics order by id")
      .then((r) => r.rows);

  beforeAll(async () => {
    t = await createTestDatabase();
    await ingestFixtures(t, new HashingEmbeddings());
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.db.exec(
      "delete from public.request_metrics; delete from public.chat_sessions; delete from public.rate_limit_buckets;",
    );
    app = await build();
  });

  it("answers, cites the site, and records a content-free metric", async () => {
    steps.push(toolUse({ name: "get_appointment_information" }), (request) =>
      finalAnswer({
        answer: "Atiende en San Miguel y en Boulogne.",
        kind: "answered",
        source_ids: sourceIdsIn(request),
        actions: ["whatsapp"],
      }),
    );
    const response = await post({ message: "¿Dónde atiende? Mi DNI es 30.123.456" });
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      answer: "Atiende en San Miguel y en Boulogne.",
      kind: "answered",
      sources: [
        {
          title: "Consultorio San Miguel",
          url: "https://drluisghilino.com.ar/#consultorio-san-miguel",
        },
        {
          title: "Consultorio Boulogne",
          url: "https://drluisghilino.com.ar/#consultorio-boulogne",
        },
      ],
      actions: [
        { type: "whatsapp", label: "Escribir por WhatsApp", url: "https://wa.me/5491140336567" },
      ],
    });
    expect(body.conversationId).toMatch(/^[0-9a-f-]{36}$/);

    const [row] = await metrics();
    expect(row).toMatchObject({
      route: "/v1/chat",
      outcome: "ok",
      answer_kind: "answered",
      llm_calls: 2,
    });
    expect(row?.tool_calls).toEqual(["get_appointment_information"]);
    // Nothing the visitor typed reaches the metrics table or the logs.
    expect(JSON.stringify(row)).not.toContain("Dónde");
    expect(JSON.stringify(logs)).not.toContain("Dónde");
    expect(JSON.stringify(logs)).not.toContain("30.123.456");
  });

  it("keeps an encrypted session that the next message continues and DELETE removes", async () => {
    steps.push(
      finalAnswer({ answer: "¡Hola!", kind: "smalltalk" }),
      finalAnswer({ answer: "¡De nada!", kind: "smalltalk" }),
    );
    const first = (await (await post({ message: "hola, soy Juan" })).json()) as {
      conversationId: string;
    };
    const stored = await t.db.query<{ payload: string }>(
      "select payload from public.chat_sessions",
    );
    expect(stored.rows[0]?.payload).toMatch(/^v1\./);
    expect(stored.rows[0]?.payload).not.toContain("Juan");

    await post({ message: "gracias", conversationId: first.conversationId });
    expect(llm.requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

    const deleted = await app.request(`/v1/chat/${first.conversationId}`, {
      method: "DELETE",
      headers: { Origin: ORIGIN },
    });
    expect(deleted.status).toBe(204);
    expect((await t.db.query("select 1 from public.chat_sessions")).rows).toHaveLength(0);
  });

  it("rejects other origins, oversized bodies and malformed requests before any model call", async () => {
    const cases: Array<[Response, number, string]> = [
      [
        await post({ message: "hola" }, { Origin: "https://evil.example" }),
        403,
        "forbidden_origin",
      ],
      [await post("x".repeat(9000)), 413, "payload_too_large"],
      [await post({ message: "hola" }, { "Content-Type": "text/plain" }), 400, "validation"],
      [await post("{not json"), 400, "validation"],
      [await post({ message: "hola", conversationId: "not-a-uuid" }), 400, "validation"],
      [await post({ message: "x".repeat(801) }), 400, "validation"],
    ];
    for (const [response, status, category] of cases) {
      expect(response.status).toBe(status);
      expect(((await response.json()) as { error: { category: string } }).error.category).toBe(
        category,
      );
    }
    expect(llm.requests).toHaveLength(0);
    expect((await metrics()).every((row) => row.outcome === "rejected")).toBe(true);
  });

  it("answers CORS preflights for allowed origins only", async () => {
    const preflight = (origin: string) =>
      app.request("/v1/chat", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
    expect((await preflight(ORIGIN)).headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(
      (await preflight("https://evil.example")).headers.get("Access-Control-Allow-Origin"),
    ).toBeNull();
  });

  it("rate-limits per client, with Retry-After, without storing the IP", async () => {
    app = await build({ RATE_LIMIT_PER_MINUTE: "2" });
    steps.push(
      finalAnswer({ answer: "a", kind: "smalltalk" }),
      finalAnswer({ answer: "b", kind: "smalltalk" }),
    );
    expect((await post({ message: "hola" })).status).toBe(200);
    expect((await post({ message: "hola" })).status).toBe(200);
    const limited = await post({ message: "hola" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Another client is not affected.
    steps.push(finalAnswer({ answer: "c", kind: "smalltalk" }));
    expect((await post({ message: "hola" }, { "X-Forwarded-For": "198.51.100.9" })).status).toBe(
      200,
    );
    const keys = await t.db.query<{ bucket_key: string }>(
      "select bucket_key from public.rate_limit_buckets",
    );
    expect(JSON.stringify(keys.rows)).not.toContain("203.0.113.7");
  });

  it("stops calling the model once the daily budget is spent", async () => {
    app = await build({ DAILY_BUDGET_USD: "0.01" });
    await t.db.query(
      `insert into public.request_metrics (request_id, channel, route, outcome, latency_ms, estimated_cost_usd)
       values (gen_random_uuid(), 'web', '/v1/chat', 'ok', 10, 0.02)`,
    );
    const response = await post({ message: "¿Dónde atiende?" });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { answer: string; kind: string; actions: unknown[] };
    expect(body.kind).toBe("abstained");
    expect(body.answer).toContain("011 4033-6567");
    expect(body.actions).toHaveLength(1);
    expect(llm.requests).toHaveLength(0);
    expect((await metrics()).at(-1)?.outcome).toBe("budget_exceeded");
  });

  it("answers emergencies without the model and records the fast path", async () => {
    const response = await post({ message: "no puedo respirar" });
    const body = (await response.json()) as { kind: string; answer: string };
    expect(body.kind).toBe("emergency");
    expect(body.answer).toContain("107");
    expect(llm.requests).toHaveLength(0);
    expect((await metrics())[0]?.outcome).toBe("emergency_fast_path");
  });

  it("degrades to a safe 503 with contact buttons when the model fails", async () => {
    // No scripted step: the stand-in throws, like a provider outage.
    const response = await post({ message: "¿Dónde atiende?" });
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      error: { category: string; message: string };
      actions: unknown[];
    };
    expect(body.error.message).toContain("WhatsApp");
    expect(body.actions).toHaveLength(1);
    expect((await metrics())[0]).toMatchObject({ outcome: "error", error_category: "internal" });
  });

  it("serves the widget texts with a short public cache", async () => {
    const response = await app.request("/v1/config", { headers: { Origin: ORIGIN } });
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    const body = (await response.json()) as {
      disclosure: string;
      suggestions: string[];
      privacyNote: string;
    };
    expect(body.disclosure).toContain("inteligencia artificial");
    expect(body.privacyNote).toContain("30 minutos");
    expect(body.suggestions.length).toBeGreaterThan(0);
    // The WhatsApp button under the greeting comes from the verified clinic profile.
    expect((body as unknown as { actions: Array<{ type: string; url: string }> }).actions).toEqual([
      expect.objectContaining({
        type: "whatsapp",
        url: expect.stringMatching(/^https:\/\/wa\.me\//),
      }),
    ]);
  });

  it("serves the widget script to other origins, and 404 when it is not built", async () => {
    expect((await app.request("/widget.js")).status).toBe(404);
    const withWidget = await createAppFromEnv(ENV, {
      version: "test",
      rpc: t.rpc,
      llm,
      embeddings: new HashingEmbeddings(),
      widgetScript: "console.log('widget');",
    });
    const response = await withWidget.request("/widget.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(await response.text()).toBe("console.log('widget');");
  });

  it("runs maintenance only with the token, deleting expired sessions", async () => {
    await t.db.query(
      `insert into public.chat_sessions (id, channel, payload, created_at, last_activity_at, expires_at)
       values (gen_random_uuid(), 'web', 'v1.x', now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour')`,
    );
    const denied = await app.request("/internal/maintenance", {
      method: "POST",
      headers: { Authorization: "Bearer wrong" },
    });
    expect(denied.status).toBe(403);
    const ran = await app.request("/internal/maintenance", {
      method: "POST",
      headers: { Authorization: `Bearer ${MAINTENANCE_TOKEN}` },
    });
    expect(ran.status).toBe(200);
    expect(((await ran.json()) as { result: { sessions: number } }).result.sessions).toBe(1);
  });

  it("sets security headers on every response", async () => {
    const response = await app.request("/health");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("keeps the runtime functions closed to the public key", async () => {
    for (const fn of [
      "rl_hit",
      "session_get",
      "metrics_record",
      "budget_spent_today",
      "maintenance_cleanup",
    ]) {
      await expect(
        t
          .rpcAs("anon")
          .value(
            fn,
            fn === "rl_hit"
              ? { p_key: "k", p_window_seconds: 60, p_limit: 1 }
              : fn === "session_get"
                ? { p_id: crypto.randomUUID() }
                : fn === "metrics_record"
                  ? { p_row: {} }
                  : {},
          ),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
