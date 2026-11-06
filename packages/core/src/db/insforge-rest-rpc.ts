import { type RpcArgs, type RpcClient, RpcError } from "./rpc.ts";

/**
 * RpcClient over InsForge's REST endpoint `POST /api/database/rpc/<fn>`, with `fetch` only.
 *
 * The edge function uses this instead of `@insforge/sdk`: the function needs nothing but our SQL
 * functions, and the SDK pulls in a PostgREST client and an older zod that pnpm overrides for
 * Node (GHSA-mrhx-c7xc-m3w5) but Deno would install as published. Same endpoint and headers the SDK
 * uses (`database.rpc` → /api/database/rpc/<fn>, admin key as a Bearer token); a live test checks
 * both clients return the same thing.
 */
export class InsforgeRestRpcClient implements RpcClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      apiKey: string;
      timeoutMs: number;
      fetch?: typeof fetch;
    },
  ) {}

  async rows<T>(fn: string, args: RpcArgs = {}): Promise<T[]> {
    const data = await this.call(fn, args);
    if (data === null) return [];
    return (Array.isArray(data) ? data : [data]) as T[];
  }

  async value<T>(fn: string, args: RpcArgs = {}): Promise<T> {
    const data = await this.call(fn, args);
    // A function returning one row comes back as a one-element array.
    if (Array.isArray(data) && data.length === 1) return data[0] as T;
    return data as T;
  }

  private async call(fn: string, args: RpcArgs): Promise<unknown> {
    if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new RpcError(fn, "invalid function name");
    const doFetch = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(
        `${this.options.baseUrl.replace(/\/$/, "")}/api/database/rpc/${fn}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch (error) {
      throw new RpcError(fn, (error as Error).name, { cause: error });
    }
    const text = await response.text();
    if (!response.ok) {
      // PostgREST errors carry a Postgres code (42501 = permission denied); keep it, drop the body.
      let code = String(response.status);
      try {
        const body = JSON.parse(text) as { code?: unknown };
        if (typeof body.code === "string") code = body.code;
      } catch {}
      throw new RpcError(fn, `HTTP ${response.status} (${code})`);
    }
    if (text === "") return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RpcError(fn, "invalid JSON response");
    }
  }
}
