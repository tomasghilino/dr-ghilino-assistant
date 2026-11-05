# AGENTS.md

## This project

Dr. Ghilino AI Assistant: a RAG chat assistant and embeddable widget for drluisghilino.com.ar.
Read [ARCHITECTURE.md](ARCHITECTURE.md), [DEVELOPMENT.md](DEVELOPMENT.md) and the ADRs in
[docs/adr](docs/adr) before changing structure. Rules that are easy to break:

- `packages/core` uses web-standard APIs only (it runs on Deno and Node); no Node imports there.
- Every table a migration creates revokes the default grants to `anon`/`authenticated` and enables
  RLS with no policies; data access goes through SQL functions executable by `project_admin` only.
- Never put the admin API key, `.insforge/project.json` or `.env.local` contents in code, logs or
  commits. Never log visitor message text.
- Only publish facts the doctor's site states (docs/knowledge-inventory.md). Do not modify the
  doctor's website repository.
- Run `pnpm verify` before committing; `pnpm test:live` after applying migrations.

<!-- INSFORGE:START -->
## InsForge backend

This project uses [InsForge](https://insforge.dev): an all-in-one, open-source Postgres-based backend (BaaS) that gives this app a database, authentication, file storage, edge functions, realtime, an AI model gateway, and payments through one platform.

- **Project:** **dr-ghilino-assistant** (API base `https://c94k6z7z.us-east.insforge.app`)
- **Skills:** these InsForge skills are installed for supported coding agents. Reach for them before implementing any InsForge feature instead of guessing the API:
  - `insforge`: app code with the `@insforge/sdk` client (database CRUD, auth, storage, edge functions, realtime, AI, email, and Stripe payments).
  - `insforge-cli`: backend and infrastructure via the `insforge` CLI (projects, SQL, migrations, RLS policies, storage buckets, functions, secrets, payment setup, schedules, deploys).
  - `insforge-debug`: diagnosing failures (SDK/HTTP errors, RLS denials, auth and OAuth issues) and running security or performance audits.
  - `insforge-integrations`: wiring external auth providers (Clerk, Auth0, WorkOS, Better Auth, etc.) for JWT-based RLS, or the OKX x402 payment facilitator.
  - `find-skills`: discovering additional skills on demand.
- **Credentials:** app code reads keys from `.env.local`; the CLI reads `.insforge/project.json`. Never hardcode or commit keys.

Key patterns:

- Database inserts take an array: `insert([{ ... }])`.
- Reference users with `auth.users(id)`; use `auth.uid()` in RLS policies.
- For storage uploads, persist both the returned `url` and `key`.
<!-- INSFORGE:END -->
