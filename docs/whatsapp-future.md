# A future WhatsApp channel (not implemented)

The brief asks for "one agent, one knowledge base, multiple communication channels" and for no
WhatsApp yet. This is how WhatsApp would plug in, so the decision can be made later without
redesigning anything.

## What stays the same

`ChatService` (`packages/core/src/chat/service.ts`) is the whole pipeline: clean the text,
emergency fast path, redact personal data, run the agent, remember the last turns. It takes an
`InboundMessage { channel, conversationId, text }` and returns an `OutboundMessage { answer,
kind, sources, actions, telemetry }`. The agent, the four tools, the knowledge base, the prompt and
every safety rule are shared. `chat_sessions.channel` already accepts `whatsapp`.

## What a WhatsApp adapter would add

A second edge function, `whatsapp-webhook`, next to `chat-api`:

1. **Verification**: answer Meta's `hub.challenge` GET with a verify token from secrets.
2. **Signature check**: reject any POST whose `X-Hub-Signature-256` is not the HMAC-SHA256 of the
   raw body with the app secret (constant-time compare), before parsing it.
3. **Idempotency**: Meta retries deliveries. Keep processed message ids for a day (a small table or
   the rate-limit table) and ignore repeats.
4. **Conversation id**: `conversationId = uuidv5(HMAC(phone number, salt))`. The phone number never
   reaches the model, the session table or the metrics.
5. **Rendering**: WhatsApp has no buttons for arbitrary links in free-form replies. Sources become
   one line of links; `actions` become text ("Para pedir turno: wa.me/…" is moot inside WhatsApp, so
   only directions and e-mail remain).
6. **Rules of the platform**: replies are free only within 24 hours of the visitor's last message;
   outside that window, only pre-approved templates. The assistant never starts conversations.
7. **Rate limits**: per hashed phone number instead of per IP, plus the same daily budget.
8. **Media**: audio, images and documents get a fixed reply ("Por ahora solo puedo leer texto").

## What it would cost and need

- A Meta Business account, a WhatsApp Business phone number (it cannot be the doctor's personal
  WhatsApp at the same time), and the Cloud API app. Meta charges per conversation category;
  service conversations started by the user have been free at times, so check current pricing.
- The practice's decision on whether the assistant, or a person, answers on that number.

## Why not now

The brief says not to implement it, and the web widget has to prove itself first: the evaluation
(Phase 7) measures whether the answers are good enough to put on a channel where the visitor
expects a human.
