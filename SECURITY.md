# Security

What can go wrong with a public, anonymous chat endpoint that spends money on every message and
talks about health, and what stops it. Status: implemented and tested locally (Phases 1–5); not
deployed (DEPLOYMENT.md).

## Assets and threats

| Asset                                 | Threat                                                          |
| ------------------------------------- | --------------------------------------------------------------- |
| Anthropic and Voyage credits          | Scripted abuse, a bot farming answers, runaway loops            |
| Admin key, session key, provider keys | Leak through code, logs, the widget bundle or the repository    |
| Visitors' messages                    | Stored, logged, or shown to the wrong person                    |
| The practice's reputation             | Invented facts, medical advice, injected instructions, defacing |
| The doctor's site                     | Script injection through the widget                             |

## Controls

**Secrets.** Provider keys, the InsForge admin key, the session key, the rate-limit salt and the
maintenance token live in `.env.local` (git-ignored) and, in production, in InsForge function
secrets. The widget holds no secret. Configuration errors name variables, never values (tested).
`.insforge/project.json` is git-ignored.

**Database.** Every table revokes InsForge's default grants to `anon` and `authenticated` and has
row-level security with no policies. All data access goes through SQL functions executable by
`project_admin` only, with a pinned `search_path`. A live test proves the public anon key gets
`42501 permission denied` on tables and functions.

**HTTP (`apps/api`).** For `POST /v1/chat`, cheapest checks first, before anything reads the
message:

1. `Origin` must be in `ALLOWED_ORIGINS` (403 otherwise). CORS answers preflights for those origins
   only.
2. Body at most `MAX_BODY_BYTES` (8 KiB, 413), `Content-Type: application/json`, schema-validated
   with zod, message at most `MAX_MESSAGE_CHARS` (800).
3. Rate limit per client: 8 per minute and 60 per day by default, fixed windows in Postgres, keyed
   by an HMAC of the IP with a secret salt. 429 with `Retry-After`.
4. Daily budget: once the estimated spend since midnight (Buenos Aires) reaches `DAILY_BUDGET_USD`,
   the API stops calling the model and answers with the WhatsApp line.

Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a
`Content-Security-Policy` of `default-src 'none'`, HSTS and `Cache-Control: no-store` (the widget
config is the only cacheable response). Errors return a category and a fixed Spanish message;
upstream messages and stack traces never reach the client.

**The model.** Four read-only tools: a successful prompt injection can change wording, never act.
Retrieved text is wrapped in `<source>` blocks with `<` and `>` escaped, and the prompt says it is
data. The output guard discards answers that contain the prompt canary, removes links outside the
allowlist, turns uncited factual answers into abstentions, and caps the length (ADR 0012). Links
under answers are built by the server from verified data and checked again by the API and the
widget.

**XSS.** The widget renders every model and API string as text (`textContent`), never as HTML, in a
Shadow DOM. Link targets must be `https:` on the site, WhatsApp or Google Maps, or `tel:` /
`mailto:`; anything else is not rendered as a link (Phase 6).

**Sessions.** Conversation turns are redacted, then encrypted with AES-256-GCM using a key held in
function secrets; the session id and channel are authenticated data, so ciphertext cannot be moved
between rows. Sessions expire 30 minutes after the last message. The session id is a random UUID
(122 bits), known only to the browser that started it.

**Maintenance.** `POST /internal/maintenance` exists only when `MAINTENANCE_TOKEN` (32+ characters)
is set, and compares the bearer token through hashes.

**Logs and metrics.** Structured JSON lines with request id, outcome, status, category, kind and
latency. No message text, no IP, no session id. `request_metrics` has no column that could hold
them.

**Supply chain.** Exact versions in every `package.json`, a lockfile, `pnpm audit` in CI. The edge
function imports four npm packages (Anthropic SDK, Hono, zod) by exact version; it talks to
InsForge with `fetch` instead of `@insforge/sdk`, whose transitive zod 3 has an advisory that pnpm
overrides for Node but Deno would install as published.

## Known limitations

- **Origin is a browser control.** A script can send any `Origin` header. Rate limits and the daily
  budget are what bound a determined client.
- **The client IP comes from a proxy header** (`CLIENT_IP_HEADER`, `x-forwarded-for` by default).
  Which header InsForge's function platform sets, and whether it overwrites a client-supplied value,
  must be checked on the first deploy. If it does not overwrite it, per-client limits can be
  dodged, and only the daily budget holds.
- **The budget is read every 30 seconds per instance**, so a burst can overshoot it by a few
  requests. With Haiku at about US$0.0006 per message that is cents.
- **Shared IPs** (a clinic's Wi-Fi, mobile carriers) share a rate-limit bucket.
- **Regex redaction** misses names and free-form health details; the widget asks visitors not to
  share them.

## Reporting

This is a private project. Report security issues to the repository owner directly, not in a
public issue.
