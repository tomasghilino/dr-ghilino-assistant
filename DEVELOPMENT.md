# Development

## Requirements

- Node 24 (`.nvmrc`) and pnpm 12 (`corepack enable`).
- No Docker needed: database tests run Postgres in process with PGlite (ADR 0008).

## Setup

```bash
pnpm install
cp .env.example .env.local   # fill in what you have; see below
pnpm cli config:check         # lists missing or invalid variables by name
```

## Everyday commands

| Command                     | What it does                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm verify`               | Lint, type check and all tests. Run before every push.                              |
| `pnpm test:unit`            | Pure functions, fast.                                                               |
| `pnpm test:integration`     | Real SQL on PGlite with every migration applied, HTTP via Hono.                     |
| `pnpm test:live`            | Opt-in checks against the real InsForge project (needs `.env.local`). Never in CI.  |
| `pnpm typecheck`            | `tsc` per package (TypeScript 7).                                                   |
| `pnpm lint` / `format`      | Biome.                                                                              |
| `pnpm dev:api`              | Local API on http://localhost:8787 (health only in Phase 1).                        |
| `pnpm cli <command>`        | Admin CLI. `pnpm cli` lists the commands.                                           |
| `pnpm cli db:status`        | Admin-key health probe of the InsForge database (counts only).                      |
| `pnpm cli ingest --dry-run` | Fetch, extract, chunk and dedupe the sources; print the chunks. No writes.          |
| `pnpm cli ingest`           | Index the knowledge base (see KNOWLEDGE_BASE.md).                                   |
| `pnpm cli kb:list`          | Published documents, versions and chunk counts.                                     |
| `pnpm cli search "<q>"`     | How one question is ranked and gated; `--context` prints what the model would read. |
| `pnpm cli eval:retrieval`   | Run the retrieval evaluation and write a report (see EVALUATION.md).                |
| `pnpm cli ask "<q>"`        | One question through the real assistant: answer, sources, tools, tokens, cost.      |
| `pnpm cli chat`             | A conversation with the real assistant in the terminal (memory-only session).       |

## Layout

```
packages/core     Runtime-agnostic domain and application code (no Node/Deno APIs)
  src/config      Environment schema (zod). The only place that knows variable names.
  src/db          RpcClient port: every database call is a SQL function (ADR 0005)
  src/domain      Shared types
  src/embeddings  EmbeddingProvider port, Voyage and OpenAI-compatible adapters
  src/ingestion   Admin-only pipeline (subpath @ghilino/core/ingestion, never in the API bundle)
  src/lib         Hashing, text normalisation, stable JSON, errors
  test/support    PGlite test database, offline hashing embedder, site fixtures, fake fetch
  test/fixtures   Snapshots of the live site (2026-11-05)
apps/api          HTTP adapter (Hono). Node entry now; InsForge (Deno) entry in Phase 5
apps/cli          Admin commands (ingest, eval, ops), Node only
migrations/       SQL migrations (InsForge CLI format: <14-digit version>_<name>.sql)
knowledge/        sources.json: the allowlist of what the assistant may learn from
docs/             Knowledge inventory, ADRs, learning notes
```

## Rules the code follows

- `packages/core` is type-checked with `"types": []`, so using `process`, `Buffer` or any Node
  module there fails the build. That is what keeps it deployable to Deno.
- Configuration is parsed once at the entry point and passed down; nothing else reads env vars.
- No `any` (Biome `noExplicitAny` is an error). Validate external data with zod at the boundary.
- Logs and errors never include message text, API keys or upstream error bodies.
- Migrations must run on PostgreSQL 15 (InsForge) even though tests use Postgres 18, and every table
  they create must revoke the default grants InsForge gives `anon` and `authenticated` (ADR 0005).
- InsForge work goes through `npx -y @insforge/cli` (see AGENTS.md); see DEPLOYMENT.md for the project.

## Tests

- Unit tests sit next to the code (`*.test.ts`).
- Integration tests end in `*.int.test.ts`. They create a fresh PGlite database per file
  (`createTestDatabase()` from `@ghilino/core/testing`), so they are independent and need no setup.
  The harness first recreates what a fresh InsForge project has (roles, pgvector, default grants),
  then applies the migrations as `project_admin`, like `insforge db migrations up` does.
- Live tests end in `*.live.test.ts` and only run with `pnpm test:live`.
