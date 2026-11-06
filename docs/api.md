# HTTP API

Base URL: `http://localhost:8787` locally (`pnpm dev:api`); on InsForge,
`https://c94k6z7z.us-east.insforge.app/functions/chat-api` once deployed (not yet, DEPLOYMENT.md).
All bodies are JSON. Every response has an `X-Request-Id` header on chat routes, and security
headers on every route (SECURITY.md).

## `GET /health`

```json
{ "status": "ok", "version": "dev", "time": "2026-11-06T17:02:45.687Z" }
```

## `GET /v1/config`

Texts for the widget. Cacheable for 5 minutes.

```json
{
  "title": "Asistente virtual",
  "subtitle": "Dr. Luis Ghilino · Traumatología",
  "greeting": "Hola, soy el asistente virtual del consultorio del Dr. Ghilino. ...",
  "disclosure": "Soy un asistente virtual con inteligencia artificial. ...",
  "privacyNote": "Tus mensajes se procesan con servicios de inteligencia artificial de terceros. ...",
  "suggestions": ["¿Dónde atiende?", "¿Qué días y horarios atiende?", "..."],
  "maxMessageChars": 800
}
```

## `POST /v1/chat`

Request (from an allowed `Origin`, `Content-Type: application/json`, at most 8 KiB):

```json
{ "message": "¿y los sábados atiende?", "conversationId": "e7e86763-1aad-48ab-ade5-e21b5fa71d78" }
```

`conversationId` is optional. Omit it (or send `null`) to start a conversation; send back the one
the previous reply returned to continue it. An unknown or expired id starts a new conversation.

Response `200`:

```json
{
  "conversationId": "e7e86763-1aad-48ab-ade5-e21b5fa71d78",
  "answer": "Sí, los sábados atiende en el consultorio de Boulogne, de 10 a 12 h. ...",
  "kind": "answered",
  "sources": [
    { "title": "Consultorio Boulogne", "url": "https://drluisghilino.com.ar/#consultorio-boulogne" }
  ],
  "actions": [
    { "type": "whatsapp", "label": "Escribir por WhatsApp", "url": "https://wa.me/5491140336567" }
  ],
  "requestId": "b176065d-8c53-464e-b53e-52f7e719887f"
}
```

`kind` is one of `answered`, `abstained`, `declined_medical`, `emergency`, `out_of_scope`,
`smalltalk`. `answer` is plain text: render it as text. `actions[].type` is `whatsapp`, `call`,
`email` or `directions`.

When the daily budget is spent, the reply is still `200`, with `kind: "abstained"`, the WhatsApp
line in `answer` and one WhatsApp action, and no model call.

Errors:

| Status | `error.category`    | When                                                            |
| ------ | ------------------- | --------------------------------------------------------------- |
| 400    | `validation`        | Not JSON, wrong content type, bad schema, message too long      |
| 403    | `forbidden_origin`  | `Origin` missing or not allowed                                 |
| 413    | `payload_too_large` | Body over 8 KiB                                                 |
| 429    | `rate_limited`      | Too many messages from this client; see `Retry-After` (seconds) |
| 503    | `upstream_llm`, ... | The model or a provider failed; `actions` holds WhatsApp        |
| 504    | `timeout`           | The 20-second turn deadline passed                              |

```json
{
  "error": {
    "category": "rate_limited",
    "message": "Enviaste muchos mensajes seguidos. Probá de nuevo en unos minutos."
  },
  "requestId": "…"
}
```

## `DELETE /v1/chat/{conversationId}`

"Borrar conversación". From an allowed `Origin`. `204`, also when the id does not exist.

## `POST /internal/maintenance`

For the InsForge schedule. `Authorization: Bearer <MAINTENANCE_TOKEN>`. Deletes expired sessions,
rate-limit buckets older than two days and metrics older than 90 days.

```json
{ "ok": true, "result": { "sessions": 3, "rate_limit_buckets": 120, "metrics": 0 } }
```

## Channels

The web API is one adapter around `ChatService` (`packages/core/src/chat`). A WhatsApp channel
would be another (docs/whatsapp-future.md); the agent, knowledge base and safety rules are shared.
