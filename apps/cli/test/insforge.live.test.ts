import { existsSync } from "node:fs";
import { InsforgeRpcClient } from "@ghilino/core";
import { createAdminClient, createClient } from "@insforge/sdk";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Live checks against the real InsForge project. Opt-in (`pnpm test:live`), never in CI:
 * they need credentials from .env.local and the network.
 *
 * They prove, end to end through InsForge's public data API, what the PGlite tests prove in
 * process: the admin key reaches our SQL functions, and the public anon key reaches nothing.
 */
const LIVE = process.env.LIVE === "1";
const PERMISSION_DENIED = "42501";
if (LIVE && existsSync(".env.local")) process.loadEnvFile(".env.local");

describe.skipIf(!LIVE)("InsForge project (live)", () => {
  let baseUrl: string;
  let apiKey: string;
  let anonKey: string;

  beforeAll(() => {
    baseUrl = required("INSFORGE_BASE_URL");
    apiKey = required("INSFORGE_API_KEY");
    anonKey = required("INSFORGE_ANON_KEY");
  });

  it("admin key: calls assistant_status() on Postgres 15 with pgvector", async () => {
    const rpc = new InsforgeRpcClient(createAdminClient({ baseUrl, apiKey, timeout: 10_000 }));
    const status = await rpc.value<{ postgres: string; vector: string }>("assistant_status");
    expect(status.postgres).toMatch(/^15\./);
    expect(status.vector).toMatch(/^0\.\d+\.\d+$/);
  });

  it("anon key: cannot call our SQL functions", async () => {
    const anon = createClient({ baseUrl, anonKey, timeout: 10_000 });
    const calls: Array<[string, Record<string, unknown>]> = [
      ["assistant_status", {}],
      [
        "kb_hybrid_search",
        {
          p_query_embedding: `[${new Array(1024).fill(0).join(",")}]`,
          p_query_text: "consulta",
          p_embedding_model: "voyage-4",
        },
      ],
    ];
    for (const [fn, args] of calls) {
      const { data, error } = await anon.database.rpc(fn, args);
      expect(data, fn).toBeNull();
      // 42501 = insufficient_privilege: denied by Postgres, not a network or routing failure.
      expect(error?.code, fn).toBe(PERMISSION_DENIED);
    }
  });

  it("anon key: cannot read or write any app table", async () => {
    const anon = createClient({ baseUrl, anonKey, timeout: 10_000 });
    for (const table of ["kb_chunks", "kb_documents", "chat_sessions", "request_metrics"]) {
      const read = await anon.database.from(table).select("*").limit(1);
      expect(read.error?.code, `read ${table}`).toBe(PERMISSION_DENIED);
    }
    const write = await anon.database
      .from("chat_sessions")
      .insert([
        { id: crypto.randomUUID(), channel: "web", payload: "x", expires_at: "2100-01-01" },
      ]);
    expect(write.error?.code).toBe(PERMISSION_DENIED);
  });
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}
