import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

// Local development entry. The InsForge (Deno) entry is added with the chat endpoint in Phase 5.
const port = Number(process.env.PORT ?? 8787);
const app = createApp({ version: process.env.APP_VERSION ?? "dev" });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});
