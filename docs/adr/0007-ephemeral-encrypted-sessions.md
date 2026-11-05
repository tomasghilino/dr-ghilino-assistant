# ADR 0007: Ephemeral, encrypted server-side sessions; no conversation logs

Date: 2026-11-05 · Status: accepted

## Context

Follow-up questions ("¿y los sábados?") need the previous turns. Visitors may type health details
despite the disclaimer. A future WhatsApp channel cannot keep history on the client.

## Decision

`chat_sessions` keeps at most the last 6 turns, AES-GCM encrypted with `SESSION_ENCRYPTION_KEY`
(a function secret, not in the database), `expires_at` 30 minutes after the last message, deleted on
explicit "borrar conversación", opportunistically by every session write, and by an InsForge schedule
that calls a maintenance endpoint every 10 minutes (`pg_cron` is installed on InsForge but not callable
by `project_admin`, verified 2026-11-05). Reads ignore expired rows, so cleanup lag never extends a
session. Application logs and metrics
never contain message text.

## Alternatives

- **Client-held history** (sessionStorage): nothing stored server-side, but the client can forge
  assistant turns (an injection vector) and it does not work for WhatsApp.
- **Plain-text session rows**: simpler, but readable in database dumps and backups.
