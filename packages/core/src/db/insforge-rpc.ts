import { type RpcArgs, type RpcClient, RpcError } from "./rpc.ts";

/**
 * The slice of the InsForge SDK client this adapter needs. Declared structurally so the core
 * does not depend on `@insforge/sdk`: the entry files (Deno function, Node CLI) create the real
 * client with `createAdminClient({ baseUrl, apiKey })` and pass it in.
 */
export interface InsforgeDatabaseClient {
  database: {
    rpc(fn: string, args?: Record<string, unknown>): PromiseLike<InsforgeRpcResult>;
  };
}

export interface InsforgeRpcResult {
  data: unknown;
  error: { message: string; code?: string | undefined } | null;
}

/**
 * RpcClient over InsForge's data API (PostgREST `POST /rpc/<fn>`). With the admin key the call
 * runs as `project_admin`, the same role our migrations and PGlite tests use.
 */
export class InsforgeRpcClient implements RpcClient {
  constructor(private readonly client: InsforgeDatabaseClient) {}

  async rows<T>(fn: string, args: RpcArgs = {}): Promise<T[]> {
    const data = await this.call(fn, args);
    if (data === null) return [];
    if (!Array.isArray(data)) throw new RpcError(fn, "expected a set-returning function");
    return data as T[];
  }

  async value<T>(fn: string, args: RpcArgs = {}): Promise<T> {
    const data = await this.call(fn, args);
    // A function declared `returns table` or `setof` comes back as an array even for one row.
    return (Array.isArray(data) && data.length <= 1 ? (data[0] ?? null) : data) as T;
  }

  private async call(fn: string, args: RpcArgs): Promise<unknown> {
    let result: InsforgeRpcResult;
    try {
      result = await this.client.database.rpc(fn, args);
    } catch (error) {
      throw new RpcError(fn, "request failed", { cause: error });
    }
    if (result.error) {
      // PostgREST messages can quote input values; keep the code, not the details.
      const code = result.error.code ? ` (${result.error.code})` : "";
      throw new RpcError(fn, `${result.error.message}${code}`);
    }
    return result.data;
  }
}
