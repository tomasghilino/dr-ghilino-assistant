# ADR 0010: Call Voyage over REST with our own timeout and retry policy

Date: 2026-11-05 · Status: accepted

## Context

Voyage publishes an official TypeScript client (`voyageai`), but it defaults to the legacy
`api.voyageai.com` host while keys created in MongoDB Atlas need `https://ai.mongodb.com/v1`. The same
adapter must run in the Deno edge function (query embeddings) and in the Node CLI (ingestion), and
its errors must never carry the input text, which may be a visitor's question.

## Decision

`VoyageEmbeddings` posts to `${VOYAGE_BASE_URL}/embeddings` with `fetch`: `input`, `model`,
`input_type` (`document` or `query`) and `output_dimension` (1024). A shared `postJson` helper adds a
per-attempt timeout (`AbortSignal.timeout`), exponential backoff with jitter on 408/409/429/5xx and
network errors, `Retry-After` support, and maps failures to `AppError("upstream_embeddings")` with the
HTTP status only. Responses are validated with zod, sorted by `index`, and every vector is checked
for length and finite values.

## Alternatives

- **Official client**: less code, but one more dependency in the edge bundle, a default host that is
  wrong for our keys, and retry/timeout behaviour we would have to configure and trust anyway.
- **InsForge AI gateway**: disabled on the Free plan (verified 2026-11-05).

## Consequences

About 60 lines of adapter code, fully unit-tested with a scripted `fetch` (request shape, batching,
ordering, retries, non-echoing errors, wrong dimensions). The Anthropic integration (Phase 4) uses the
official SDK instead, because its surface (tool use, thinking blocks, usage) is far larger.
