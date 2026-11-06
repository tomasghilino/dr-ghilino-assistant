# Deployment

Status: **deployed on 2026-11-06.** The `chat-api` function (version `9fa6658`, branch
`phase-8-deploy`) answers at `https://c94k6z7z.us-east.insforge.app/functions/chat-api?path=/…`,
serves the widget, and passed the smoke test against production (9/9). The cleanup schedule runs
every 10 minutes. The widget is on the doctor's site through `tomasghilino/luisGhilinoMedico` PR #5
(Tomi's go-ahead the same day).

## InsForge project

| Item         | Value                                                          |
| ------------ | -------------------------------------------------------------- |
| Project      | `dr-ghilino-assistant` (Personal Org, Free plan)               |
| Region       | `us-east`                                                      |
| API base URL | `https://c94k6z7z.us-east.insforge.app`                        |
| Postgres     | 15.18, pgvector 0.7.4, `spanish` text search config            |
| Created      | 2026-11-05 with `npx -y @insforge/cli create --template empty` |

The Free plan pauses a project after 7 days without requests. Fine for development; before the
widget goes on the doctor's site, decide between keep-alive traffic and the Pro plan ($25/month).

### Linking a machine

```bash
npx -y @insforge/cli login --user-api-key <uak_...>   # or plain `login` for the browser flow
npx -y @insforge/cli link --project-id 569c6e00-a972-4b68-a168-6ff66f4ca6b2
```

`link` writes `.insforge/project.json` (project id, admin API key, URL). It is git-ignored and must
stay that way. App code reads its keys from `.env.local`, never from that file.

### Credentials

| Name                 | Where it lives                      | Who may see it                    |
| -------------------- | ----------------------------------- | --------------------------------- |
| User API key `uak_…` | CLI login on the admin's machine    | The account owner only            |
| Admin API key `ik_…` | `.env.local`, later function secret | Server code only (bypasses RLS)   |
| Anon key             | `.env.local` for live tests         | Public by design; reaches nothing |

Rotate the admin key with `npx -y @insforge/cli secrets rotate api-key` (prints the new key once)
and update `.env.local` and the function secret before the grace period ends.

## Database migrations

Migrations live in `migrations/` with the CLI's naming rule (`<14-digit version>_<name>.sql`; a test
enforces it). Create, write, test locally, then apply:

```bash
npx -y @insforge/cli db migrations new <name>
pnpm test:integration                     # runs every migration on PGlite as project_admin
npx -y @insforge/cli db migrations up --all
npx -y @insforge/cli db migrations list
pnpm test:live                            # proves admin works and the anon key is denied
```

Never edit a migration after it is applied; write a new one.

### Applied

| Version          | Name                                | Applied              |
| ---------------- | ----------------------------------- | -------------------- |
| `20261105192937` | `init-schema`                       | 2026-11-05 19:31 UTC |
| `20261105204859` | `kb-ingestion-functions`            | 2026-11-05 21:02 UTC |
| `20261105214536` | `kb-hybrid-search`                  | 2026-11-05 21:58 UTC |
| `20261105220124` | `kb-hybrid-search-lexical-coverage` | 2026-11-05 22:03 UTC |
| `20261106164602` | `clinic-active-profile`             | 2026-11-06 16:51 UTC |
| `20261106165556` | `api-runtime-functions`             | 2026-11-06 17:00 UTC |

## Health check

```bash
pnpm cli db:status
```

Calls `assistant_status()` with the admin key and prints counts (sources, documents, chunks,
embedding models). It never prints content.

## Deploying the API

The function is one ESM file built from `apps/api` and `packages/core`, with third-party packages
as `npm:` imports (ADR 0001, ADR 0013).

```bash
pnpm --filter @ghilino/api bundle        # builds the widget, then apps/api/dist/chat-api.js (about 108 KiB)
```

The same function serves the widget at `GET /widget.js` (the build is inlined in the bundle), so
one deploy publishes both, and the script always matches the API it talks to.

To run the bundle on Deno locally, `Deno.serve()` its default export from a two-line file and run
`npx -y deno@2.9.6 run --allow-net --allow-env --allow-read --env-file=.env.local serve.ts`.

### 1. Function secrets

InsForge secrets reach every function as environment variables. Two come with the project and are
reserved: `INSFORGE_BASE_URL` and `API_KEY` (the admin key; the function reads it as
`INSFORGE_API_KEY`, so a key rotation needs no change). Set on 2026-11-06, values never printed or
committed:

| Secret                   | Value                                                                  |
| ------------------------ | ---------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | the Anthropic key                                                      |
| `VOYAGE_API_KEY`         | the Voyage key                                                         |
| `RATE_LIMIT_SALT`        | 32 random bytes, hex (production only, not the one in `.env.local`)    |
| `SESSION_ENCRYPTION_KEY` | 32 random bytes, base64 (production only)                              |
| `SAFETY_PROMPT_CANARY`   | `GHL-` + 8 random bytes, hex (one value, so instances share the cache) |
| `MAINTENANCE_TOKEN`      | 32 random bytes, hex                                                   |
| `ALLOWED_ORIGINS`        | `https://drluisghilino.com.ar,https://www.drluisghilino.com.ar`        |
| `DAILY_BUDGET_USD`       | `2`                                                                    |
| `CLIENT_IP_TRUSTED_HOPS` | `2` (see "What the first deploy showed")                               |
| `APP_ENV`                | `production`                                                           |
| `APP_VERSION`            | the short commit hash of the deployed code (shown by `/health`)        |

```bash
npx -y @insforge/cli secrets add RATE_LIMIT_SALT "$(openssl rand -hex 32)"   # one per secret
npx -y @insforge/cli secrets update APP_VERSION --value "$(git rev-parse --short HEAD)"
```

A running instance reads its configuration once, so **redeploy after changing a secret**.

### 2. Deploy and smoke-test

```bash
pnpm --filter @ghilino/api bundle
npx -y @insforge/cli secrets update APP_VERSION --value "$(git rev-parse --short HEAD)"
npx -y @insforge/cli functions deploy chat-api --file apps/api/dist/chat-api.js \
  --name "Chat API" --description "Dr. Ghilino assistant: POST /v1/chat, GET /widget.js"
pnpm cli smoke --url "https://c94k6z7z.us-east.insforge.app/functions/chat-api?path=/" \
               --origin https://drluisghilino.com.ar
```

`pnpm cli smoke` needs no keys: it checks the public API the way the widget uses it (health and
version, the widget script, the widget texts, the preflight, a foreign origin refused, the
emergency fast path, one real question and its follow-up, DELETE) and exits with 1 if anything
fails. `--no-model` skips the two checks that call Claude. Production, 2026-11-06: 9/9.

### What the first deploy showed

A throwaway function that echoed its request headers (deployed, called, deleted) answered the three
open questions:

- **Routing.** The documented URL, `https://<project>/functions/<slug>`, does not route sub-paths:
  `/functions/chat-api/v1/chat` is a 404. The function receives the path `/chat-api`, so the route
  travels as `?path=/v1/chat` (`apps/api/src/platform.ts`). The deploy also reports a second host,
  `https://c94k6z7z.function2.insforge.app/<slug>/…`, which does route sub-paths, but it is not in
  InsForge's docs, so nothing depends on it.
- **Client IP.** `X-Forwarded-For` arrives as `<whatever the client sent>, <visitor>, <internal
  LB>, <gateway>`. The first entry, which the code used until then, can be forged by anyone, so the
  visitor is now read two entries from the end (`CLIENT_IP_TRUSTED_HOPS=2`). Checked in production:
  ten requests with ten forged addresses hit the per-minute limit as one client.
- **CORS belongs to the gateway.** InsForge answers preflights itself and sets
  `Access-Control-Allow-Origin: *` on responses, replacing ours. The widget sends no credentials,
  so browsers accept it. Pages on other sites are still refused, by the API's own `Origin` check
  (403 before anything else runs), which browsers do not let a page forge.
- **Timeout.** Still not documented. Answers take about 3 seconds (p95 about 5) against a 20-second
  turn deadline.

### 3. Cleanup schedule

```bash
npx -y @insforge/cli schedules create --name "Assistant cleanup" --cron "*/10 * * * *" \
  --url "https://c94k6z7z.us-east.insforge.app/functions/chat-api?path=/internal/maintenance" \
  --method POST --headers '{"Authorization": "Bearer ${{secrets.MAINTENANCE_TOKEN}}"}'
```

Created on 2026-11-06 (`npx -y @insforge/cli schedules logs <id>` shows each run). It deletes
expired sessions, two-day-old rate-limit counters and metrics older than 90 days. It also keeps the
project active: the Free plan pauses a project after 7 days without requests, and this is a request
every 10 minutes. If the project ever shows as paused (`npx -y @insforge/cli projects get`), that
assumption was wrong: restore it and move to a daily external check or the Pro plan.

### 4. On the doctor's site

Installed with Tomi's go-ahead on 2026-11-06: one `<Script>` in the site's root layout, production
only, bottom left (the WhatsApp button is bottom right). Embed code and steps:
[docs/widget.md](docs/widget.md#install). To take the assistant off the site, delete that tag; to
stop it everywhere, delete the function (`npx -y @insforge/cli functions delete chat-api`).

Still open: rotate the `uak_` user key that was pasted in a chat.
