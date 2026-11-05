import { describe, expect, it } from "vitest";
import {
  type InsforgeDatabaseClient,
  InsforgeRpcClient,
  type InsforgeRpcResult,
} from "./insforge-rpc.ts";
import { RpcError } from "./rpc.ts";

function fakeClient(result: InsforgeRpcResult | Error) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const client: InsforgeDatabaseClient = {
    database: {
      rpc: async (fn, args) => {
        calls.push({ fn, args });
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
  return { client, calls };
}

describe("InsforgeRpcClient", () => {
  it("passes named arguments through and returns rows", async () => {
    const { client, calls } = fakeClient({ data: [{ id: 1 }, { id: 2 }], error: null });
    const rows = await new InsforgeRpcClient(client).rows<{ id: number }>("hybrid_search", {
      match_count: 5,
    });
    expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls).toEqual([{ fn: "hybrid_search", args: { match_count: 5 } }]);
  });

  it("unwraps scalar and single-row results for value()", async () => {
    expect(
      await new InsforgeRpcClient(fakeClient({ data: { ok: true }, error: null }).client).value(
        "assistant_status",
      ),
    ).toEqual({ ok: true });
    expect(
      await new InsforgeRpcClient(fakeClient({ data: [{ hits: 3 }], error: null }).client).value(
        "rate_limit_hit",
      ),
    ).toEqual({ hits: 3 });
  });

  it("turns PostgREST errors into RpcError with the code but no details", async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: "permission denied for function assistant_status", code: "42501" },
    });
    await expect(new InsforgeRpcClient(client).value("assistant_status")).rejects.toThrow(
      new RpcError("assistant_status", "permission denied for function assistant_status (42501)"),
    );
  });

  it("wraps network failures", async () => {
    const { client } = fakeClient(new TypeError("fetch failed"));
    await expect(new InsforgeRpcClient(client).rows("x")).rejects.toBeInstanceOf(RpcError);
  });
});
