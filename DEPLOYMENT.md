# Deployment

Status: **database only.** The InsForge project exists and the schema is applied. Nothing public
is deployed yet: no edge function, no widget, no secrets for Anthropic or Voyage. This file grows
with Phases 5, 6 and 8.

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

| Version          | Name          | Applied              |
| ---------------- | ------------- | -------------------- |
| `20261105192937` | `init-schema` | 2026-11-05 19:31 UTC |

## Health check

```bash
pnpm cli db:status
```

Calls `assistant_status()` with the admin key and prints counts (sources, documents, chunks,
embedding models). It never prints content.
