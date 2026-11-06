# Learning notes: Phase 5, the backend API

The agent works. Phase 5 puts it behind a public URL without letting the internet empty the
Anthropic account, read conversations, or break the doctor's site.

## 1. The shape of a request

```
widget ──POST /v1/chat {message, conversationId}──▶ HTTP adapter (Hono)
                                                     │ origin? size? JSON? schema?
                                                     │ rate limit (Postgres)
                                                     │ daily budget (Postgres)
                                                     ▼
                                                 ChatService ── agent ── Claude / Voyage / tools
                                                     │
                                                     ├─ session saved, encrypted (Postgres)
                                                     └─ metrics row, no text (Postgres)
```

The adapter has no business logic. It translates HTTP into a call on `ChatService` and back, which
is why a WhatsApp adapter could be added without touching the agent.

## 2. Cheap checks first

Each check is cheaper than the next, so garbage is rejected before it costs anything:

| Check           | Cost                      | Stops                                   |
| --------------- | ------------------------- | --------------------------------------- |
| Origin          | a string comparison       | other websites embedding the endpoint   |
| Size, JSON, zod | parsing 8 KiB at most     | junk and oversized payloads             |
| Rate limit      | one SQL call per window   | one client sending hundreds of messages |
| Daily budget    | one SQL call per 30 s     | everyone together spending too much     |
| The agent       | 2 model calls, ~US$0.0006 | (this is the real work)                 |

**Origin** is not authentication: a script can fake it. It stops other websites from using our
endpoint from their visitors' browsers. The rate limit and the budget are what bound a determined
attacker.

## 3. Rate limiting with a fixed window

`rl_hit('ip:<hash>:minute', 60, 8)` does one upsert:

```sql
insert into rate_limit_buckets (bucket_key, window_start, hits) values (key, <start of this minute>, 1)
on conflict do update set hits = hits + 1
returning hits;
```

If `hits` is over the limit, the API answers 429 with `Retry-After`. The key is an **HMAC** of the
IP with a secret salt: the table never holds an IP, and without the salt nobody can recover one
(IPv4 has only 4 billion values, so a plain hash could be reversed by trying them all).

## 4. A budget instead of trust

`budget_spent_today()` adds up the estimated cost of today's requests. Above US$2 (configurable),
the API stops calling the model and answers with the WhatsApp line. Even if every other control
failed, the worst day costs the budget.

## 5. Sessions that a database dump cannot read

"¿y los sábados?" only makes sense after "¿dónde atiende?", so the last turns are kept. Encrypted:

- AES-256-GCM with a random 12-byte IV per write; the key is a function secret, not in the database;
- the session id and channel are **authenticated data**: copying a ciphertext into another row
  makes decryption fail;
- 30 minutes after the last message the row is expired (reads ignore it) and later deleted.

## 6. Running the same code on Node and Deno

InsForge functions run on Deno. Tests and local development run on Node. The core uses only web
standards (`fetch`, WebCrypto), so the same code runs on both. An esbuild script bundles our code
into one file and leaves third-party packages as `npm:hono@4.13.16`-style imports, which Deno
downloads itself. We ran that exact file on Deno 2.9.6 and it answered a real question.

We also replaced the InsForge SDK with a 60-line `fetch` client in the function: we only call SQL
functions, and the SDK dragged in an old zod with a security advisory that we can override for Node
but not for Deno. A live test proves both clients return the same results.

## 7. What we measured against the real services

Two questions through the local API, real Claude, Voyage and InsForge:

| Question                    | Model calls | Cached tokens read | Cost       | Latency |
| --------------------------- | ----------- | ------------------ | ---------- | ------- |
| ¿Cuánto cuesta la consulta? | 2           | 2,957              | US$0.00057 | 5.0 s   |
| ¿y los sábados atiende?     | 2           | 5,914              | US$0.00028 | 4.3 s   |

The second one is cheaper because the system prompt and tools were already in Anthropic's cache.

## Self-check questions

1. Why is the rate-limit key an HMAC and not a SHA-256 of the IP?
2. A competitor writes a script that sends `Origin: https://drluisghilino.com.ar`. What stops it?
3. What happens to a session if `SESSION_ENCRYPTION_KEY` is rotated?
4. Why is the budget check cached for 30 seconds, and what is the cost of that choice?
5. What would you need to change to run the API on Cloudflare Workers instead of InsForge?
