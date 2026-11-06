# ADR 0013: The HTTP API: cheap checks first, limits in Postgres, and a fetch RPC client

Date: 2026-11-06 · Status: accepted

## Context

The chat endpoint is anonymous and every message costs money. InsForge has no built-in rate
limiting for functions. The function runs on Deno; tests and local development run on Node.

## Decision

**Order of checks**: origin → size → content type → schema → rate limit → budget → chat. Each step
is cheaper than the next, and nothing before the chat service reads the message.

**Rate limits in Postgres**: `rl_hit(key, window, limit)` upserts a fixed-window counter and
returns whether the hit is allowed, in one call. Keys are an HMAC of the IP with a secret salt
(minute and day windows). Old buckets are deleted by the maintenance job.

**A daily budget circuit breaker**: `budget_spent_today()` sums the estimated cost in
`request_metrics` since midnight in Buenos Aires. Each instance re-reads it every 30 seconds and
adds its own spend in between. Above `DAILY_BUDGET_USD` the API answers with the WhatsApp line
without calling the model.

**Sessions**: AES-256-GCM in WebCrypto, the session id and channel as authenticated data, the key in
function secrets; `session_put` also deletes a few expired rows per write.

**Content-free metrics**: one `request_metrics` row per chat request through `metrics_record(jsonb)`,
whose target table has no column for text, ids or IPs.

**A fetch-based RpcClient for the function** (`InsforgeRestRpcClient`): `POST
/api/database/rpc/<fn>` with the admin key as a Bearer token, the same endpoint the SDK uses. The
function needs only our SQL functions; `@insforge/sdk` would add a PostgREST client and a zod 3
dependency with an advisory that pnpm overrides for Node but Deno would install unpatched. A live
test checks both clients return the same values and that the anon key gets 42501.

**Bundling**: esbuild bundles `apps/api` and `packages/core` into one ESM file and rewrites
third-party imports to `npm:<name>@<exact version>` (Anthropic SDK, Hono, zod). Verified by running
that exact file on Deno 2.9.6 and answering a real chat request through `/functions/chat-api/...`.

## Alternatives

- **Sliding-window or token-bucket limits**: smoother, but more SQL and more writes; fixed windows
  are enough at 8 per minute.
- **Rate limiting in memory**: free and fast, but every function instance would have its own
  counters.
- **An external limiter (Upstash, Cloudflare)**: another paid service and another secret.
- **A hard budget per request instead of per day**: does not stop a slow, steady drain.
- **`@insforge/sdk` in the function**: one client for everything, but a heavier, unpatched
  dependency tree on Deno.

## Consequences

- The client IP header must be confirmed on the platform (SECURITY.md, known limitations).
- The maintenance job needs an InsForge schedule and a `MAINTENANCE_TOKEN` secret (DEPLOYMENT.md).
- Every chat request makes two to four extra database calls (rate limit ×2, session read and write,
  metrics). Measured locally against InsForge from Buenos Aires: total latency 4–5 s, dominated by
  the two model calls.
