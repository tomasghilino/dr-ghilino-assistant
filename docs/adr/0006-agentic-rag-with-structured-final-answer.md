# ADR 0006: Agentic RAG (the model chooses tools) with a validated final answer

Date: 2026-11-05 · Status: accepted; the final-answer format was confirmed in Phase 4 ([ADR 0012](0012-agent-loop-structured-answer-and-safety-layers.md))

## Context

Classic RAG retrieves before every model call. Here many messages need no retrieval (greetings),
and structured facts (hours, phone) are better served by a dedicated tool than by text chunks.

## Decision

The model gets four read-only tools and decides which to call. The server enforces: at most 4 tool
rounds, a 20 s deadline per turn, schema validation of every tool input, and an output guard that
rejects a factual `kind: "answered"` answer that cites no retrieved source.

## Alternatives

- **Always retrieve, single call**: one round trip fewer (faster, cheaper), but wasted retrieval on
  small talk and no structured tools. We measure both in the eval; if retrieval-first wins on
  latency without losing accuracy we can add it as a pre-fetch without changing the tools.
