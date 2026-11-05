import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { type RpcArgs, type RpcClient, RpcError } from "../../src/db/rpc.ts";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../migrations/", import.meta.url));
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
type Role = "project_admin" | "anon" | "authenticated";

/**
 * What an InsForge project looks like before our migrations run, as observed on the real
 * project on 2026-11-05 (`pg_roles`, `pg_default_acl`): the three runtime roles, pgvector
 * installed by the platform, and default grants that give the browser roles full DML on every
 * new public table. Reproducing the grants is what makes the migration's REVOKEs testable.
 */
const INSFORGE_BASELINE = `
  create role anon nologin;
  create role authenticated nologin;
  create role project_admin nologin bypassrls;
  create extension vector;
  grant usage, create on schema public to project_admin;
  grant usage on schema public to anon, authenticated;
  alter default privileges for role project_admin in schema public
    grant select, insert, update, delete on tables to anon, authenticated;
  alter default privileges for role project_admin in schema public
    grant select, usage on sequences to anon, authenticated;
`;

export interface TestDatabase {
  db: PGlite;
  /** Calls SQL functions as `project_admin`, like the server-side API key does on InsForge. */
  rpc: RpcClient;
  /** Same calls as another role, for permission tests. */
  rpcAs(role: Role): RpcClient;
  close(): Promise<void>;
}

/** Fresh in-memory Postgres (PGlite) with every migration applied as `project_admin`. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await PGlite.create({ extensions: { vector } });
  await db.exec(INSFORGE_BASELINE);
  for (const file of await listMigrations()) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    try {
      await db.exec(`set role project_admin;\n${sql}\n;reset role;`);
    } catch (error) {
      await db.exec("reset role");
      throw new Error(`migration ${file} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return {
    db,
    rpc: new PgliteRpcClient(db, "project_admin"),
    rpcAs: (role) => new PgliteRpcClient(db, role),
    close: () => db.close(),
  };
}

export async function listMigrations(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
}

/**
 * Test adapter for RpcClient: calls the same SQL functions production calls through PostgREST,
 * with named arguments (`fn(arg => $1)`, which is how PostgREST maps a JSON body to a call) and
 * under the same role.
 */
export class PgliteRpcClient implements RpcClient {
  constructor(
    private readonly db: PGlite,
    private readonly role: Role,
  ) {}

  async rows<T>(fn: string, args: RpcArgs = {}): Promise<T[]> {
    const { call, params } = buildCall(fn, args);
    return this.asRole(fn, async (tx) => (await tx.query<T>(`select * from ${call}`, params)).rows);
  }

  async value<T>(fn: string, args: RpcArgs = {}): Promise<T> {
    const { call, params } = buildCall(fn, args);
    return this.asRole(fn, async (tx) => {
      const result = await tx.query<{ value: T }>(`select ${call} as value`, params);
      return (result.rows[0]?.value ?? null) as T;
    });
  }

  private async asRole<T>(fn: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.exec(`set local role ${this.role}`);
        return work(tx);
      });
    } catch (error) {
      throw new RpcError(fn, (error as Error).message, { cause: error });
    }
  }
}

type Transaction = Parameters<Parameters<PGlite["transaction"]>[0]>[0];

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
