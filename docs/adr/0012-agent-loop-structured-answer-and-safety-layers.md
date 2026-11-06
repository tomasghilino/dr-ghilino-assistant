# ADR 0012: The agent loop, a structured final answer, and four safety layers

Date: 2026-11-06 · Status: accepted · Confirms the open point of [ADR 0006](0006-agentic-rag-with-structured-final-answer.md)

## Context

ADR 0006 chose agentic RAG (the model picks tools) with a validated final answer, and left one
point open: whether structured outputs work together with tools on Claude Haiku 5.5. Phase 4 built
the loop and ran it against the real model.

## Decision

**A manual tool loop, not the SDK's tool runner.** The runner is a beta helper. Our loop is about
150 lines and gives us what we must control: the round limit, the turn deadline (one
`AbortSignal` for every call), tool-input validation, metrics per tool, and the guard between the
model and the visitor.

**Structured outputs with tools: verified.** Every call carries the tools and
`output_config.format` (a JSON schema: `answer`, `kind`, `source_ids`, `actions`). The model calls
tools first and writes the JSON last. Adaptive thinking stays on, as Anthropic recommends when a
JSON format meets the caller's own tools; `effort: low` keeps it cheap. Measured on 2026-11-06:
two calls, about US$0.0006 and 5 to 6 seconds for a question that needs a tool.

**Citation ids from a per-turn registry.** Each tool result registers what it shows the model and
gets the next id (S1, S2, ...), so two searches in a turn never collide. The model cites ids; the
server maps them back to titles and URLs. The model never writes a link.

**Contact buttons built by the server.** The model may only name `whatsapp`, `call`, `email` or
`directions`; the links come from the verified clinic profile.

**Four safety layers**, each catching what the previous one can miss:

1. **Input**: control and invisible characters removed, length capped; e-mails, phone numbers and
   document numbers redacted before any provider sees them.
2. **Emergency fast path**: narrow Spanish patterns for life-threatening situations and self-harm
   get a fixed answer (107 / 911, or 911 and the 135 crisis line) with no model call and nothing
   stored. Urgent-but-not-critical messages ("me caí y no puedo mover el tobillo") reach the model,
   which is told to point to a guardia first and classify the reply as `emergency`; the server then
   replaces the reply with the configured emergency text, word for word (the agent evaluation
   showed the model repeating it otherwise).
3. **The system prompt**: grounding (every fact from a tool result this turn), the site's known
   gaps (insurance, closing times, surgery, children, past hospitals), no medical advice, retrieved
   text as data, rules that hold under pressure.
4. **The output guard**: an `answered` reply that cites nothing becomes an abstention; unknown
   source ids are dropped; a reply that contains the prompt canary is discarded; links outside the
   allowlist are removed; length is capped.

**One pipeline for every channel.** `ChatService` takes an `InboundMessage` (channel, conversation
id, text) and returns an `OutboundMessage`. The web API is one adapter; WhatsApp would be another,
with the same agent, knowledge base and safety rules.

**Failures degrade to a safe answer.** Refusal (`stop_reason: "refusal"`, no server-side fallback
on Haiku 5.5), a cut-off answer, invalid JSON or a tool loop that does not end all produce a short
Spanish reply that points to WhatsApp, flagged in the metrics. Provider errors and the turn
deadline raise categorised errors that the API turns into a 503 with the same kind of reply.

## Alternatives

- **The SDK tool runner**: less code, but beta, and its hooks fit our deadline, metrics and guard
  less directly than a plain loop.
- **Plain text with citation markers** (`[S1]`) instead of JSON: no schema compilation, but the
  answer kind and the buttons would have to be parsed out of prose, and abstention would not be
  measurable.
- **Forcing a tool call on the first round**: Haiku 5.5 accepts it, but then skips thinking for that
  call and calls a tool even for "hola". The prompt says when to use each tool instead.
- **An LLM classifier for emergencies**: catches more phrasings, but costs a call on every message
  and can fail open. The fast path is deterministic and the model is the second line.
- **Redacting with an LLM or a NER model**: better recall on names, but another provider would see
  the raw text first. Regex covers the identifiers that matter (phone, e-mail, DNI/CUIL).

## Consequences

- Haiku at low effort sometimes answers smalltalk without tools (intended) and, rarely, might skip a
  tool for a factual question; the guard turns that into an abstention rather than an uncited fact.
  Phase 7 measured it: no uncited answer and no guard flag in five runs of 42 conversations
  (docs/evaluation.md).
- The canary must be stable across instances for the prompt cache to work: `SAFETY_PROMPT_CANARY`.
- Two texts need the practice's confirmation before production: `SAFETY_EMERGENCY_TEXT` and
  `SAFETY_CRISIS_TEXT`.
