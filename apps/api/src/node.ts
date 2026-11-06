import { existsSync, readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { createAppFromEnv } from "./compose.ts";

// Local development entry: the same app as the InsForge function, on Node, with .env.local.
// Requests from the demo page come from http://localhost:5173 (add it to ALLOWED_ORIGINS).
if (existsSync(".env.local")) process.loadEnvFile(".env.local");
else if (existsSync("../../.env.local")) process.loadEnvFile("../../.env.local");

const port = Number(process.env.PORT ?? 8787);
// Serve the widget too when it has been built (pnpm --filter @ghilino/widget build).
const widgetPath = new URL("../../widget/dist/widget.js", import.meta.url);
const app = await createAppFromEnv(
  { ...process.env, CLIENT_IP_HEADER: process.env.CLIENT_IP_HEADER ?? "x-forwarded-for" },
  {
    version: process.env.APP_VERSION ?? "dev",
    ...(existsSync(widgetPath) ? { widgetScript: readFileSync(widgetPath, "utf8") } : {}),
  },
);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`api listening on http://localhost:${info.port}`);
});
