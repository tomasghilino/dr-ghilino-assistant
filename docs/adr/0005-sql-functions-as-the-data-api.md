# ADR 0005: SQL functions are the only data API; RLS denies everything else

Date: 2026-11-05 · Status: accepted

## Context

InsForge exposes tables through PostgREST to anyone holding the public anon key. The edge function
reaches the database through the SDK (`rpc()`), not a raw connection. Ingestion needs atomic
"replace this document's chunks" writes.

## Decision

- Every table has RLS enabled and **no policies**, so the anon and authenticated roles see nothing.
- Every read and write is a SQL function. `EXECUTE` is revoked from `PUBLIC` and granted to the
  admin role only. The function and the CLI use the admin key, stored as a secret.
- The core talks to the database through `RpcClient.call(fn, args)`. Production uses the InsForge
  SDK; tests run the same functions on PGlite with `select * from fn(arg => $1, ...)`.

## Consequences

Business rules that touch data (fusion, versioning, rate-limit windows) live in SQL and are tested
through the same entry points production uses. Tests run on Postgres 18 (PGlite) while InsForge runs
15, so migrations avoid post-15 features and are smoke-tested on the real project.
