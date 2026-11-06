import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerChatRoutes } from "./chat-routes.ts";
import { safeActions } from "./http.ts";
import type { AppDeps } from "./types.ts";
import { WIDGET_CONFIG } from "./widget-config.ts";

export type { AppDeps, ChatDeps, HttpSettings } from "./types.ts";

/**
 * HTTP adapter (docs/architecture.md §2, component 2). It translates HTTP into calls on the core
 * and back; it holds no business logic. Dependencies are passed in by the entry file (Node for
 * local development and tests, Deno on InsForge), which is the composition root.
 */
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

  // The widget is served by the same function as the API: one deploy, and the script and the API
  // it talks to always match. Pages on other origins load it with a plain <script> tag.
  const widgetScript = deps.widgetScript;
  if (widgetScript) {
    app.get("/widget.js", (c) => {
      c.header("Content-Type", "text/javascript; charset=utf-8");
      c.header("Cache-Control", "public, max-age=3600");
      c.header("Cross-Origin-Resource-Policy", "cross-origin");
      return c.body(widgetScript);
    });
  }

  app.get("/v1/config", async (c) => {
    c.header("Cache-Control", "public, max-age=300");
    // The WhatsApp button under the greeting, from the verified profile (empty if unavailable).
    const contact = deps.chat ? await deps.chat.contact().catch(() => null) : null;
    return c.json({
      ...WIDGET_CONFIG,
      privacyNote: WIDGET_CONFIG.privacyNote.replace(
        "{minutes}",
        String(settings?.sessionTtlMinutes ?? 30),
      ),
      maxMessageChars: settings?.maxMessageChars ?? 800,
      actions: contact ? safeActions(contact.actions) : [],
    });
  });

  if (deps.chat && settings) {
    registerChatRoutes(app, {
      chat: deps.chat,
      settings,
      clientIp: deps.clientIp ?? (() => "unknown"),
      log,
    });
  }

  app.notFound((c) => c.json({ error: { category: "not_found", message: "Not found" } }, 404));
  app.onError((error, c) => {
    log({ level: "error", msg: "unhandled", name: error.name });
    return c.json({ error: { category: "internal", message: "Internal error" } }, 500);
  });

  return app;
}
