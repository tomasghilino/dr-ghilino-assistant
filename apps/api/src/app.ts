import {
  type ChatService,
  type ContactAction,
  type DailyBudget,
  isAppError,
  type MetricsSink,
  type OutboundMessage,
  type RateLimiter,
  type RequestOutcome,
  sha256Hex,
} from "@ghilino/core";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { WIDGET_CONFIG } from "./widget-config.ts";

/**
 * HTTP adapter (ARCHITECTURE.md §2, component 2). It translates HTTP into calls on the core and
 * back; it holds no business logic. Dependencies are passed in by the entry file (Node for local
 * development and tests, Deno on InsForge), which is the composition root.
 *
 * Order of checks for POST /v1/chat, cheapest first: origin → size → content type → schema →
 * rate limit → daily budget → chat. Nothing before the chat service reads the message text.
 */
export interface ChatDeps {
  chat: ChatService;
  limiter: RateLimiter;
  budget: DailyBudget;
  metrics: MetricsSink;
  /** WhatsApp line and contact buttons for answers given without the model. */
  contact: () => Promise<{ whatsappText: string; actions: ContactAction[] }>;
  /** Runs `maintenance_cleanup()`; exposed only when a maintenance token is configured. */
  maintenance?: () => Promise<unknown>;
}

export interface HttpSettings {
  allowedOrigins: readonly string[];
  maxMessageChars: number;
  maxBodyBytes: number;
  /** Bearer token for POST /internal/maintenance (InsForge schedule). Unset: endpoint disabled. */
  maintenanceToken?: string;
  /** Session lifetime shown in the widget's privacy note. */
  sessionTtlMinutes: number;
}

export interface AppDeps {
  version: string;
  now?: () => Date;
  chat?: ChatDeps;
  settings?: HttpSettings;
  /** The client address as the platform reports it (used only as a rate-limit key, hashed). */
  clientIp?: (request: Request) => string;
  /** Structured, content-free logs. */
  log?: (entry: Record<string, unknown>) => void;
}

const SITE_HOSTS = ["drluisghilino.com.ar"];
const ACTION_HOSTS = ["wa.me", "www.google.com", "google.com"];

const chatBodySchema = z.object({
  conversationId: z.uuid().nullish(),
  message: z.string(),
});

export function createApp(deps: AppDeps): Hono {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((entry) => console.log(JSON.stringify(entry)));
  const settings = deps.settings;
  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    c.header("Strict-Transport-Security", "max-age=31536000");
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  });

  if (settings) {
    app.use(
      "/v1/*",
      cors({
        origin: (origin) => (settings.allowedOrigins.includes(origin) ? origin : null),
        allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type"],
        maxAge: 600,
      }),
    );
  }

  app.get("/health", (c) =>
    c.json({ status: "ok", version: deps.version, time: now().toISOString() }),
  );

  app.get("/v1/config", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json({
      ...WIDGET_CONFIG,
      privacyNote: WIDGET_CONFIG.privacyNote.replace(
        "{minutes}",
        String(settings?.sessionTtlMinutes ?? 30),
      ),
      maxMessageChars: settings?.maxMessageChars ?? 800,
    });
  });

  const chatDeps = deps.chat;
  if (chatDeps && settings) {
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
          await chatDeps.metrics.record({
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
        if (reply) chatDeps.budget.add(reply.telemetry.estimatedCostUsd);
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
        const decision = await chatDeps.limiter.check(deps.clientIp?.(c.req.raw) ?? "unknown");
        if (!decision.allowed) {
          c.header("Retry-After", String(decision.retryAfterSeconds));
          return finish(errorResponse(c, "rate_limited", requestId), "rate_limited", {
            errorCategory: "rate_limited",
          });
        }
        if (await chatDeps.budget.exceeded()) {
          const contact = await chatDeps.contact();
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

        const reply = await chatDeps.chat.handle({
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
        const contact = await chatDeps.contact().catch(() => null);
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
      await chatDeps.chat.reset(id.data);
      return c.body(null, 204);
    });

    if (settings.maintenanceToken && chatDeps.maintenance) {
      const expected = settings.maintenanceToken;
      const run = chatDeps.maintenance;
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

  app.notFound((c) => c.json({ error: { category: "not_found", message: "Not found" } }, 404));
  app.onError((error, c) => {
    log({ level: "error", msg: "unhandled", name: error.name });
    return c.json({ error: { category: "internal", message: "Internal error" } }, 500);
  });

  return app;
}

const MESSAGES: Record<string, { status: 400 | 403 | 413 | 429; message: string }> = {
  validation: { status: 400, message: "No pude leer el mensaje. Probá de nuevo." },
  forbidden_origin: { status: 403, message: "Origen no permitido." },
  payload_too_large: { status: 413, message: "El mensaje es demasiado largo." },
  rate_limited: {
    status: 429,
    message: "Enviaste muchos mensajes seguidos. Probá de nuevo en unos minutos.",
  },
};

function errorResponse(c: Context, category: string, requestId: string, message?: string) {
  const known = MESSAGES[category] ?? { status: 400 as const, message: "Solicitud inválida." };
  return c.json(
    { error: { category, message: message ?? known.message }, requestId },
    known.status,
  );
}

/** Links shown as buttons: the site's WhatsApp, phone, e-mail and Google Maps only. */
function safeActions(actions: readonly ContactAction[]): ContactAction[] {
  return actions.filter(
    (action) =>
      /^tel:\+?\d{6,15}$/.test(action.url) ||
      /^mailto:[^\s@]+@[^\s@]+$/.test(action.url) ||
      isHttpsOn(action.url, ACTION_HOSTS),
  );
}

function isHttpsOn(value: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && hosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Compare secrets through their hashes, so the comparison time does not depend on the input. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  if (!given) return false;
  const [a, b] = await Promise.all([sha256Hex(given), sha256Hex(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
