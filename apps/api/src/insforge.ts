// InsForge function entry (Deno). Bundled by `pnpm --filter @ghilino/api bundle` into
// dist/chat-api.js, with npm packages kept as `npm:` imports, and deployed with
// `npx -y @insforge/cli functions deploy chat-api --file apps/api/dist/chat-api.js`.
import { createAppFromEnv } from "./compose.ts";

declare const Deno: { env: { toObject(): Record<string, string> } };

const SLUG = "chat-api";

// Built once per instance and reused across requests (the prompt canary, caches and the database
// client live as long as the instance).
const appPromise = createAppFromEnv(Deno.env.toObject(), {
  version: Deno.env.toObject().APP_VERSION ?? "insforge",
});

export default async function handler(request: Request): Promise<Response> {
  const app = await appPromise;
  return app.fetch(normalizePath(request));
}

/**
 * Functions are served under /functions/<slug>. Strip that prefix so the app sees /v1/chat. If the
 * platform only routes the bare slug, `?path=/v1/chat` selects the route instead (to be confirmed
 * on the first deploy, DEPLOYMENT.md).
 */
function normalizePath(request: Request): Request {
  const url = new URL(request.url);
  const prefix = `/functions/${SLUG}`;
  let path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
  const override = url.searchParams.get("path");
  if ((path === "" || path === "/") && override?.startsWith("/")) path = override;
  if (path === url.pathname) return request;
  url.pathname = path || "/";
  return new Request(url, request);
}
