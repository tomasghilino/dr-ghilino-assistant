# Deployment

Status: **database and knowledge base only.** The schema is applied, the knowledge base is indexed
(25 chunks, clinic profile) and every runtime SQL function exists. The API is built and its bundle
was run on Deno locally, but **nothing public is deployed**: no edge function, no widget, no function
secrets, no schedule. Deploying is the first step that exposes a cost-incurring endpoint, so it waits
for the owner's go-ahead (see "Deploying the API" below).

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

## Deploying the API (prepared, not run)

The function is one ESM file built from `apps/api` and `packages/core`, with third-party packages
as `npm:` imports (ADR 0001, ADR 0013).

```bash
pnpm --filter @ghilino/api bundle        # builds the widget, then apps/api/dist/chat-api.js (about 108 KiB)
```

The same function serves the widget at `GET /widget.js` (the build is inlined in the bundle), so
one deploy publishes both, and the script always matches the API it talks to.

The bundle was run on Deno 2.9.6 against the real InsForge database, Claude and Voyage on
2026-11-06 and answered through `/functions/chat-api/v1/chat`, using a two-line harness that
`Deno.serve()`s the default export:

```bash
npx -y deno@2.9.6 run --allow-net --allow-env --allow-read --env-file=.env.local serve.ts
```

### 1. Function secrets

Set once (values from `.env.local` or freshly generated; never commit them):

| Secret                   | Value                                                               |
| ------------------------ | ------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | the Anthropic key                                                   |
| `VOYAGE_API_KEY`         | the Voyage key                                                      |
| `INSFORGE_BASE_URL`      | `https://c94k6z7z.us-east.insforge.app`                             |
| `INSFORGE_API_KEY`       | the admin key                                                       |
| `RATE_LIMIT_SALT`        | `openssl rand -hex 32`                                              |
| `SESSION_ENCRYPTION_KEY` | `openssl rand -base64 32`                                           |
| `SAFETY_PROMPT_CANARY`   | `openssl rand -hex 8` (every instance then shares the prompt cache) |
| `MAINTENANCE_TOKEN`      | `openssl rand -hex 32`                                              |
| `ALLOWED_ORIGINS`        | `https://drluisghilino.com.ar,https://www.drluisghilino.com.ar`     |
| `DAILY_BUDGET_USD`       | `2` (or what the practice decides)                                  |

```bash
npx -y @insforge/cli secrets add ANTHROPIC_API_KEY <value>   # one per secret
```

### 2. Deploy and smoke-test

```bash
npx -y @insforge/cli functions deploy chat-api --file apps/api/dist/chat-api.js \
  --name "Chat API" --description "Dr. Ghilino assistant: POST /v1/chat"
npx -y @insforge/cli functions list
curl -s https://c94k6z7z.us-east.insforge.app/functions/chat-api/health
pnpm cli smoke --url https://c94k6z7z.us-east.insforge.app/functions/chat-api \
               --origin https://drluisghilino.com.ar
```

`pnpm cli smoke` needs no keys: it checks the public API the way the widget uses it (health, the
widget script, CORS for the site and for a foreign origin, the emergency fast path, one real
question and its follow-up, DELETE) and exits with 1 if anything fails. Verified against the local
API with the real Claude, Voyage and InsForge on 2026-11-06 (9/9 checks); not yet against a deployed
function. Add `--no-model` to skip the two checks that call Claude.

To confirm on the first deploy (the docs do not say):

- whether sub-paths (`/functions/chat-api/v1/chat`) reach the function; if not, the entry accepts
  `/functions/chat-api?path=/v1/chat`, and the widget's `data-api` must use that form;
- which header carries the client IP and whether the platform overwrites it (`CLIENT_IP_HEADER`);
- the function timeout (the turn deadline is 20 s).

### 3. Cleanup schedule

```bash
npx -y @insforge/cli schedules create --name "Assistant cleanup" --cron "*/10 * * * *" \
  --url "https://c94k6z7z.us-east.insforge.app/functions/chat-api/internal/maintenance" \
  --method POST --headers '{"Authorization": "Bearer ${{secrets.MAINTENANCE_TOKEN}}"}'
```

### 4. Before the widget goes on the doctor's site

The embed code and the steps for the site are in [docs/widget.md](docs/widget.md#install). Before
that:

- The practice confirms `SAFETY_EMERGENCY_TEXT` and `SAFETY_CRISIS_TEXT`.
- Free plan or Pro: the Free plan pauses after 7 idle days.
- Rotate the `uak_` user key that was pasted in a chat.
