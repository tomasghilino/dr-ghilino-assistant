import { isAppError, type OutboundMessage, type RequestOutcome } from "@ghilino/core";
import type { Hono } from "hono";
import { z } from "zod";
import { errorResponse, isHttpsOn, SITE_HOSTS, safeActions, sameSecret } from "./http.ts";
import type { ChatDeps, HttpSettings } from "./types.ts";

const chatBodySchema = z.object({
  conversationId: z.uuid().nullish(),
  message: z.string(),
});

/**
 * POST /v1/chat, DELETE /v1/chat/:id and POST /internal/maintenance.
 *
 * Order of checks for POST /v1/chat, cheapest first: origin → size → content type → schema →
 * rate limit → daily budget → chat. Nothing before the chat service reads the message text.
 */
export function registerChatRoutes(
  app: Hono,
  {
    chat,
    settings,
    clientIp,
    log,
  }: {
    chat: ChatDeps;
    settings: HttpSettings;
    clientIp: (request: Request) => string;
    log: (entry: Record<string, unknown>) => void;
  },
): void {
  app.post("/v1/chat", async (c) => {
    const started = performance.now();
    const requestId = crypto.randomUUID();
    const finish = async (
      response: Response,
      outcome: RequestOutcome,
      extra: { errorCategory?: string; reply?: OutboundMessage } = {},
    ) => {
      const latencyMs = performance.now() - started;
      const reply = extra.reply;
      try {
        await chat.metrics.record({
          requestId,
          channel: "web",
          route: "/v1/chat",
          outcome,
          errorCategory: extra.errorCategory ?? null,
          answerKind: reply?.kind ?? null,
          latencyMs,
          ...(reply ? { telemetry: reply.telemetry } : {}),
        });
      } catch {
        log({ level: "warn", msg: "metrics_record_failed", requestId });
      }
      if (reply) chat.budget.add(reply.telemetry.estimatedCostUsd);
      log({
        level: outcome === "error" ? "error" : "info",
        msg: "chat",
        requestId,
        outcome,
        status: response.status,
        category: extra.errorCategory ?? null,
        kind: reply?.kind ?? null,
        latencyMs: Math.round(latencyMs),
      });
      response.headers.set("X-Request-Id", requestId);
      return response;
    };

    const origin = c.req.header("Origin");
    if (!origin || !settings.allowedOrigins.includes(origin)) {
      return finish(errorResponse(c, "forbidden_origin", requestId), "rejected", {
        errorCategory: "forbidden_origin",
      });
    }
    const declared = Number(c.req.header("Content-Length") ?? "0");
    if (declared > settings.maxBodyBytes) {
      return finish(errorResponse(c, "payload_too_large", requestId), "rejected", {
        errorCategory: "payload_too_large",
      });
    }
    if (!(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
      return finish(errorResponse(c, "validation", requestId), "rejected", {
        errorCategory: "validation",
      });
    }
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > settings.maxBodyBytes) {
      return finish(errorResponse(c, "payload_too_large", requestId), "rejected", {
        errorCategory: "payload_too_large",
      });
    }
    let body: z.infer<typeof chatBodySchema>;
    try {
      body = chatBodySchema.parse(JSON.parse(raw));
    } catch {
      return finish(errorResponse(c, "validation", requestId), "rejected", {
        errorCategory: "validation",
      });
    }
    if (body.message.length > settings.maxMessageChars) {
      return finish(
        errorResponse(
          c,
          "validation",
          requestId,
          `El mensaje es demasiado largo (máximo ${settings.maxMessageChars} caracteres).`,
        ),
        "rejected",
        { errorCategory: "validation" },
      );
    }

    try {
      const decision = await chat.limiter.check(clientIp(c.req.raw) ?? "unknown");
      if (!decision.allowed) {
        c.header("Retry-After", String(decision.retryAfterSeconds));
        return finish(errorResponse(c, "rate_limited", requestId), "rate_limited", {
          errorCategory: "rate_limited",
        });
      }
      if (await chat.budget.exceeded()) {
        const contact = await chat.contact();
        return finish(
          c.json({
            conversationId: body.conversationId ?? null,
            answer: `En este momento no puedo responder consultas. Podés escribir ${contact.whatsappText}.`,
            kind: "abstained",
            sources: [],
            actions: safeActions(contact.actions),
            requestId,
          }),
          "budget_exceeded",
        );
      }

      const reply = await chat.chat.handle({
        channel: "web",
        conversationId: body.conversationId ?? null,
        text: body.message,
      });
      return finish(
        c.json({
          conversationId: reply.conversationId,
          answer: reply.answer,
          kind: reply.kind,
          sources: reply.sources
            .filter((source) => isHttpsOn(source.url, SITE_HOSTS))
            .map((source) => ({ title: source.title, url: source.url })),
          actions: safeActions(reply.actions),
          requestId,
        }),
        reply.telemetry.fastPath ? "emergency_fast_path" : "ok",
        { reply },
      );
    } catch (error) {
      const category = isAppError(error) ? error.category : "internal";
      if (category === "validation") {
        return finish(errorResponse(c, "validation", requestId), "rejected", {
          errorCategory: category,
        });
      }
      log({
        level: "error",
        msg: "chat_failed",
        requestId,
        category,
        // The error name and our own internal message only: never upstream bodies or text.
        detail: isAppError(error) ? error.message : (error as Error).name,
      });
      const contact = await chat.contact().catch(() => null);
      return finish(
        c.json(
          {
            error: {
              category,
              message: `No pude responder en este momento. Probá de nuevo en un rato${contact ? ` o escribí ${contact.whatsappText}` : ""}.`,
            },
            actions: contact ? safeActions(contact.actions) : [],
            requestId,
          },
          category === "timeout" ? 504 : 503,
        ),
        "error",
        { errorCategory: category },
      );
    }
  });

  app.delete("/v1/chat/:conversationId", async (c) => {
    const origin = c.req.header("Origin");
    if (!origin || !settings.allowedOrigins.includes(origin)) {
      return errorResponse(c, "forbidden_origin", crypto.randomUUID());
    }
    const id = z.uuid().safeParse(c.req.param("conversationId"));
    if (!id.success) return errorResponse(c, "validation", crypto.randomUUID());
    await chat.chat.reset(id.data);
    return c.body(null, 204);
  });

  if (settings.maintenanceToken && chat.maintenance) {
    const expected = settings.maintenanceToken;
    const run = chat.maintenance;
    app.post("/internal/maintenance", async (c) => {
      const given = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!(await sameSecret(given, expected))) {
        return c.json({ error: { category: "forbidden", message: "Forbidden" } }, 403);
      }
      const result = await run();
      log({ level: "info", msg: "maintenance", result });
      return c.json({ ok: true, result });
    });
  }
}
