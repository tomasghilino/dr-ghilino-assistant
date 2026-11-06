// InsForge function entry (Deno). Bundled by `pnpm --filter @ghilino/api bundle` into
// dist/chat-api.js, with npm packages kept as `npm:` imports, and deployed with
// `npx -y @insforge/cli functions deploy chat-api --file apps/api/dist/chat-api.js`.
import { createAppFromEnv } from "./compose.ts";
import { normalizePath } from "./platform.ts";

declare const Deno: { env: { toObject(): Record<string, string> } };
/** The built widget, inlined by scripts/bundle.mjs (esbuild `define`). */
declare const __WIDGET_JS__: string;

const SLUG = "chat-api";

const env = Deno.env.toObject();
// Built once per instance and reused across requests (the prompt canary, caches and the database
// client live as long as the instance). The admin key is InsForge's reserved API_KEY secret, so a
// key rotation needs no change here; an explicit INSFORGE_API_KEY still wins.
const appPromise = createAppFromEnv(
  { INSFORGE_API_KEY: env.API_KEY ?? "", ...env },
  { version: env.APP_VERSION ?? "insforge", widgetScript: __WIDGET_JS__ },
);

export default async function handler(request: Request): Promise<Response> {
  const app = await appPromise;
  return app.fetch(normalizePath(request, SLUG));
}
