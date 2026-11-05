# ADR 0002: Claude Haiku 5.5 behind a provider port

Date: 2026-11-05 · Status: accepted

## Context

The assistant answers short administrative questions in Spanish with a couple of tool calls.
Latency and cost per visitor matter more than deep reasoning. The model must be swappable by
configuration, and another provider must be addable without touching the agent.

## Decision

- Default model `claude-haiku-5-5` ($0.10 input / $0.50 output per million tokens for prompts up to
  100K tokens; 1M context). Set by `LLM_MODEL`; prices live in a config table keyed by model id
  so cost estimates follow the model.
- `output_config.effort = "low"` by default (`LLM_EFFORT`); thinking stays adaptive (the model may
  skip it). No `temperature`/`top_p`/`top_k`: Haiku 5.5 rejects non-default sampling parameters.
- The agent depends on `LlmProvider` with neutral message, tool and usage types. The Anthropic
  adapter is the only file that imports `@anthropic-ai/sdk`. Provider-specific blocks (thinking
  signatures) travel as opaque values and are sent back unmodified inside a tool loop.
- Across turns we keep plain text only, so the conversation is append-only and never replays
  thinking blocks after a history change.
- Handle `stop_reason: "refusal"` (Haiku 5.5 has safety classifiers and no server-side fallback)
  as a safe, generic answer.

## Alternatives

- **Sonnet 5.5** ($2 / $10): 20× the cost, better reasoning we don't need for this scope. The eval
  can be re-run with `LLM_MODEL=claude-sonnet-5-5` to check that claim.
- **InsForge AI gateway (OpenRouter)**: one fewer key, but it only documents older Claude ids, adds
  a processor in the data path, and its OpenAI-style API hides Anthropic features we use.

## Consequences

Haiku at low effort may skip a search it should do; the system prompt and the output guard
(§6 of ARCHITECTURE.md) compensate, and the eval measures it.
