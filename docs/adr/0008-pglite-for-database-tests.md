# ADR 0008: PGlite for database integration tests

Date: 2026-11-05 · Status: accepted

## Context

The development machine (WSL) has no Docker. Mocking SQL would leave the most important code
(hybrid search, versioning, rate limits) untested.

## Decision

Integration tests run the real migrations on PGlite 0.5 (Postgres 18.6 compiled to WASM, in
process), with `@electric-sql/pglite-pgvector` (pgvector 0.8.7). Checked on 2026-11-05: `vector`,
the `spanish` text search configuration, `websearch_to_tsquery` and HNSW all work.

## Consequences

Fast, hermetic tests in CI and locally. Version skew with InsForge (15) is handled by ADR 0005's
rule and a smoke test against the real project.
