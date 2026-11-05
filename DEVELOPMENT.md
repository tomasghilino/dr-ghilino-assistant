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

| Command                 | What it does                                                    |
| ----------------------- | --------------------------------------------------------------- |
| `pnpm verify`           | Lint, type check and all tests. Run before every push.          |
| `pnpm test:unit`        | Pure functions, fast.                                           |
| `pnpm test:integration` | Real SQL on PGlite with every migration applied, HTTP via Hono. |
| `pnpm typecheck`        | `tsc` per package (TypeScript 7).                               |
| `pnpm lint` / `format`  | Biome.                                                          |
| `pnpm dev:api`          | Local API on http://localhost:8787 (health only in Phase 1).    |
| `pnpm cli <command>`    | Admin CLI. `pnpm cli` lists the commands.                       |

## Layout

```
packages/core     Runtime-agnostic domain and application code (no Node/Deno APIs)
  src/config      Environment schema (zod). The only place that knows variable names.
  src/db          RpcClient port: every database call is a SQL function (ADR 0005)
  src/domain      Shared types
  src/lib         Hashing, text normalisation, errors
  test/support    PGlite test database with the real migrations
apps/api          HTTP adapter (Hono). Node entry now; InsForge (Deno) entry in Phase 5
apps/cli          Admin commands (ingest, eval, ops), Node only
db/migrations     SQL migrations, applied in file-name order
docs/             Knowledge inventory, ADRs, learning notes
```

## Rules the code follows

- `packages/core` is type-checked with `"types": []`, so using `process`, `Buffer` or any Node
  module there fails the build. That is what keeps it deployable to Deno.
- Configuration is parsed once at the entry point and passed down; nothing else reads env vars.
- No `any` (Biome `noExplicitAny` is an error). Validate external data with zod at the boundary.
- Logs and errors never include message text, API keys or upstream error bodies.
- Migrations must run on PostgreSQL 15 (InsForge) even though tests use Postgres 18.

## Tests

- Unit tests sit next to the code (`*.test.ts`).
- Integration tests end in `*.int.test.ts`. They create a fresh PGlite database per file
  (`createTestDatabase()` from `@ghilino/core/testing`), so they are independent and need no setup.
