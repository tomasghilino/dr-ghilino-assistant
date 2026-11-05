import { Hono } from "hono";

/**
 * HTTP adapter (ARCHITECTURE.md §2, component 2). It translates HTTP into calls on the core and
 * back; it holds no business logic. Dependencies are passed in by the entry file (Node for local
 * development and tests, Deno on InsForge), which is the composition root.
 */
export interface AppDeps {
  version: string;
  now?: () => Date;
}

export function createApp(deps: AppDeps): Hono {
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ status: "ok", version: deps.version, time: now().toISOString() }),
  );

  app.notFound((c) => c.json({ error: { category: "not_found", message: "Not found" } }, 404));

  return app;
}
