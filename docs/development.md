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

| Command                               | What it does                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm verify`                         | Lint, type check and all tests. Run before every push.                                           |
| `pnpm test:unit`                      | Pure functions, fast.                                                                            |
| `pnpm test:integration`               | Real SQL on PGlite with every migration applied, HTTP via Hono.                                  |
| `pnpm test:live`                      | Opt-in checks against the real InsForge project (needs `.env.local`). Never in CI.               |
| `pnpm typecheck`                      | `tsc` per package (TypeScript 7).                                                                |
| `pnpm lint` / `format`                | Biome.                                                                                           |
| `pnpm dev:api`                        | Local API on http://localhost:8787 with `.env.local` (real Claude, Voyage, InsForge).            |
| `pnpm cli <command>`                  | Admin CLI. `pnpm cli` lists the commands.                                                        |
| `pnpm cli db:status`                  | Admin-key health probe of the InsForge database (counts only).                                   |
| `pnpm cli ingest --dry-run`           | Fetch, extract, chunk and dedupe the sources; print the chunks. No writes.                       |
| `pnpm cli ingest`                     | Index the knowledge base (see docs/knowledge-base.md).                                           |
| `pnpm cli kb:list`                    | Published documents, versions and chunk counts.                                                  |
| `pnpm cli search "<q>"`               | How one question is ranked and gated; `--context` prints what the model would read.              |
| `pnpm cli eval:retrieval`             | Run the retrieval evaluation and write a report (see docs/evaluation.md).                        |
| `pnpm cli eval:agent`                 | Run the agent evaluation (real Claude, judge model) and write a report (see docs/evaluation.md). |
| `pnpm cli ask "<q>"`                  | One question through the real assistant: answer, sources, tools, tokens, cost.                   |
| `pnpm cli chat`                       | A conversation with the real assistant in the terminal (memory-only session).                    |
| `pnpm cli smoke --url … --origin …`   | Check a running API from the outside, as the widget uses it (see docs/deployment.md).            |
| `pnpm cli ops:report`                 | Requests, outcomes, kinds, latency, tokens and cost from `request_metrics`.                      |
| `pnpm --filter @ghilino/api bundle`   | Build the InsForge function into `apps/api/dist/chat-api.js`.                                    |
| `pnpm --filter @ghilino/widget dev`   | Widget demo on http://localhost:5173 (run the API with `ALLOWED_ORIGINS=http://localhost:5173`). |
| `pnpm --filter @ghilino/widget build` | Build `apps/widget/dist/widget.js`.                                                              |
| `pnpm test:e2e`                       | Build the widget and run it in Chromium against the API app (PGlite, scripted model).            |

## Layout

Package by feature, with ports and adapters: each folder in `packages/core/src` owns a port (an
interface) and its adapters, and nothing in the core knows which runtime it is on.

```
packages/core            Runtime-agnostic domain and application code (no Node or Deno APIs)
  src/agent              Agent loop, system prompt, four read-only tools, citations, final answer
  src/chat               ChatService: one pipeline for every channel (clean, emergency, redact, agent)
  src/retrieval          Hybrid search, confidence gate, context assembly
  src/llm                LlmProvider port, Anthropic adapter, pricing
  src/embeddings         EmbeddingProvider port, Voyage and OpenAI-compatible adapters
  src/safety             Emergency fast path, PII redaction, output guard
  src/sessions           Encrypted session store (AES-GCM, WebCrypto)
  src/limits             Rate limiter, daily budget
  src/observability      Content-free metrics
  src/db                 RpcClient port (every database call is a SQL function, ADR 0005), adapters
  src/config             Environment schema (zod): the only place that knows variable names
  src/ingestion          Admin-only pipeline (subpath @ghilino/core/ingestion, not in the API bundle)
  src/evaluation         Retrieval and agent evaluation (subpath @ghilino/core/evaluation)
  src/domain, src/lib    Shared types; hashing, text, cache, errors
  test/support           PGlite database, hashing embedder, scripted model, site fixtures
apps/api                 HTTP adapter (Hono) and composition root; Node entry and InsForge (Deno) entry
apps/widget              The embeddable widget (vanilla TypeScript, Shadow DOM) and its e2e tests
apps/cli                 Admin commands: ingest, search, evaluations, smoke test, ops report
migrations/              SQL migrations (InsForge CLI format: <14-digit version>_<name>.sql)
knowledge/               sources.json: the allowlist of what the assistant may learn from
evals/                   Evaluation datasets and the reports every number in evaluation.md comes from
docs/                    Architecture, ADRs, deployment, evaluation, security, privacy, learning notes
```

## Rules the code follows

- `packages/core` is type-checked with `"types": []`, so using `process`, `Buffer` or any Node
  module there fails the build. That is what keeps it deployable to Deno.
- Configuration is parsed once at the entry point and passed down; nothing else reads env vars.
- No `any` (Biome `noExplicitAny` is an error). Validate external data with zod at the boundary.
- Logs and errors never include message text, API keys or upstream error bodies.
- Migrations must run on PostgreSQL 15 (InsForge) even though tests use Postgres 18, and every table
  they create must revoke the default grants InsForge gives `anon` and `authenticated` (ADR 0005).
- InsForge work goes through `npx -y @insforge/cli` (see AGENTS.md); see docs/deployment.md for the project.

## Tests

- Unit tests sit next to the code (`*.test.ts`).
- Integration tests end in `*.int.test.ts`. They create a fresh PGlite database per file
  (`createTestDatabase()` from `@ghilino/core/testing`), so they are independent and need no setup.
  The harness first recreates what a fresh InsForge project has (roles, pgvector, default grants),
  then applies the migrations as `project_admin`, like `insforge db migrations up` does.
- Live tests end in `*.live.test.ts` and only run with `pnpm test:live`.
