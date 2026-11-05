# ADR 0005: SQL functions are the only data API; privileges and RLS deny everything else

Date: 2026-11-05 · Status: accepted (revised the same day after inspecting the real project)

## Context

InsForge exposes `public` tables through PostgREST to anyone holding the public anon key.
Inspecting the real project showed:

- Migrations, `db query` and admin-key API calls all run as `project_admin` (`BYPASSRLS`), which may
  own objects only in `public`. InsForge's guidance is not to create custom schemas.
- `pg_default_acl` grants `anon` and `authenticated` SELECT/INSERT/UPDATE/DELETE on every table
  `project_admin` creates in `public`, and functions get the Postgres default (EXECUTE for PUBLIC).

The edge function reaches the database through the SDK (`rpc()`), not a raw connection. Ingestion
needs atomic "replace this document's chunks" writes.

## Decision

- App tables live in `public` (knowledge-base tables prefixed `kb_`). Each migration that creates a
  table **revokes all privileges** from `public`, `anon` and `authenticated`, and enables RLS with
  **no policies** as a second barrier.
- Every read and write is a SQL function. `EXECUTE` is revoked from `PUBLIC`, `anon` and
  `authenticated` and granted to `project_admin`. Functions are `SECURITY INVOKER` (the default), so
  even a mistaken `GRANT EXECUTE` to anon would still hit the revoked tables. Each pins
  `search_path = pg_catalog, public, pg_temp`.
- The function and the CLI use the admin API key, stored as a secret, never in a browser.
- The core talks to the database through `RpcClient` (`rows` / `value`). Production uses
  `InsforgeRpcClient` over the SDK's `database.rpc`; tests use `PgliteRpcClient`, which runs
  `select * from fn(arg => $1, ...)` inside `set local role project_admin`.

## Alternatives

- **Private schema** (the first draft): PostgREST would not expose it, but InsForge's migration role
  cannot be relied on to own objects outside `public`, and the platform tooling (dashboard, advisor,
  branching) is built around `public`.
- **Policies for anon on a public read-only projection**: unnecessary, because the browser never
  queries the database; it talks to our function only.

## Consequences

Business rules that touch data (fusion, versioning, rate-limit windows) live in SQL and are tested
through the same entry points production uses. The PGlite harness reproduces InsForge's roles and
default grants, so the REVOKEs are tested, and `pnpm test:live` checks the real project. Tests run on
Postgres 18 (PGlite) while InsForge runs 15.18, so migrations avoid post-15 features.
