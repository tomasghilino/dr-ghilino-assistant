# ADR 0003: Voyage `voyage-4` embeddings, 1024 dimensions, behind a port

Date: 2026-11-05 · Status: proposed (needs the account decision)

## Context

Anthropic does not sell embeddings. The corpus is Spanish. Indexing is tens of chunks; each
visitor question needs one query embedding.

| Option                                 | $/1M tokens   | Free                                                                                  | Spanish                                                    | Notes                                                                      |
| -------------------------------------- | ------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| Voyage `voyage-4`                      | 0.06          | 200M tokens                                                                           | "multilingual retrieval" optimised; best vendor benchmarks | query/document input types; MongoDB Atlas account; training opt-out needed |
| Voyage `voyage-4-lite`                 | 0.02          | 200M tokens                                                                           | same family, smaller                                       | same                                                                       |
| OpenAI `text-embedding-3-small`        | 0.02          | none                                                                                  | decent, older (2024)                                       | no training on API data by default                                         |
| InsForge gateway → OpenRouter → OpenAI | not published | **none: paid plans only** (verified 2026-11-05, `AI is only available on paid plans`) | as above                                                   | no new account; two extra processors                                       |
| Gemini free tier                       | 0             | yes                                                                                   | good                                                       | free-tier data used for training: rejected                                 |

## Decision

`voyage-4` at 1024 dimensions with `input_type` `document` / `query`, behind `EmbeddingProvider`.
An OpenAI-compatible adapter (OpenAI or the InsForge gateway, requesting `dimensions: 1024`) is the
fallback and lets the eval compare providers. Every chunk stores `embedding_model`; retrieval only
compares vectors from the configured model, and switching models means re-indexing.

## Consequences

Costs round to zero (well inside the free tokens). On InsForge's Free plan the AI gateway is disabled, so Voyage is also the only option here that costs nothing. The account owner must turn off "use data to
improve models" in MongoDB Atlas, and add a payment method to leave the low free-trial rate limits.
