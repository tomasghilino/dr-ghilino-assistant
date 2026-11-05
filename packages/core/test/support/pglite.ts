import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { type RpcArgs, type RpcClient, RpcError } from "../../src/db/rpc.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface TestDatabase {
  db: PGlite;
  rpc: RpcClient;
  close(): Promise<void>;
}

/** Fresh in-memory Postgres (PGlite) with every migration applied, in file-name order. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await PGlite.create({ extensions: { vector } });
  for (const file of await listMigrations()) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return { db, rpc: new PgliteRpcClient(db), close: () => db.close() };
}

export async function listMigrations(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
}

/**
 * Test adapter for RpcClient: calls the same SQL functions production calls through PostgREST,
 * using named arguments (`fn(arg => $1)`), which is how PostgREST maps a JSON body to a call.
 */
export class PgliteRpcClient implements RpcClient {
  constructor(private readonly db: PGlite) {}

  async rows<T>(fn: string, args: RpcArgs = {}): Promise<T[]> {
    const { call, params } = buildCall(fn, args);
    try {
      const result = await this.db.query<T>(`select * from ${call}`, params);
      return result.rows;
    } catch (error) {
      throw new RpcError(fn, (error as Error).message, { cause: error });
    }
  }

  async value<T>(fn: string, args: RpcArgs = {}): Promise<T> {
    const { call, params } = buildCall(fn, args);
    try {
      const result = await this.db.query<{ value: T }>(`select ${call} as value`, params);
      return (result.rows[0]?.value ?? null) as T;
    } catch (error) {
      throw new RpcError(fn, (error as Error).message, { cause: error });
    }
  }
}

function buildCall(fn: string, args: RpcArgs): { call: string; params: unknown[] } {
  if (!IDENTIFIER.test(fn)) throw new RpcError(fn, "invalid function name");
  const params: unknown[] = [];
  const named = Object.entries(args).map(([key, value], index) => {
    if (!IDENTIFIER.test(key)) throw new RpcError(fn, `invalid argument name ${key}`);
    params.push(value !== null && typeof value === "object" ? JSON.stringify(value) : value);
    return `${key} => $${index + 1}`;
  });
  return { call: `public.${fn}(${named.join(", ")})`, params };
}
