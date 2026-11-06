# AGENTS.md

## This project

Dr. Ghilino AI Assistant: a RAG chat assistant and embeddable widget for drluisghilino.com.ar.
Read [architecture.md](docs/architecture.md), [development.md](docs/development.md) and the ADRs in
[docs/adr](docs/adr) before changing structure. Rules that are easy to break:

- `packages/core` uses web-standard APIs only (it runs on Deno and Node); no Node imports there.
- Every table a migration creates revokes the default grants to `anon`/`authenticated` and enables
  RLS with no policies; data access goes through SQL functions executable by `project_admin` only.
- Never put the admin API key, `.insforge/project.json` or `.env.local` contents in code, logs or
  commits. Never log visitor message text.
- Only publish facts the doctor's site states (docs/knowledge-inventory.md). Do not modify the
  doctor's website repository.
- Run `pnpm verify` before committing; `pnpm test:live` after applying migrations.

## InsForge

The backend is an [InsForge](https://insforge.dev) project (Postgres + pgvector, Deno functions,
secrets, schedules). Use the CLI through `npx -y @insforge/cli` and the InsForge agent skills when
they are installed. Credentials: app code reads `.env.local`, the CLI reads `.insforge/project.json`;
both are git-ignored. Deploying, secrets and schedules: [docs/deployment.md](docs/deployment.md).
