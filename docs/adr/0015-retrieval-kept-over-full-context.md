# ADR 0015: Retrieval stays, with the whole-site prompt as a measured fallback

Date: 2026-11-06 · Status: accepted · Revisits [ADR 0004](0004-hybrid-search-with-rrf-in-sql.md)
and [ADR 0006](0006-agentic-rag-with-structured-final-answer.md) with data

## Context

The site is about 2,500 tokens of text. The model could read all of it on every question, which
would make retrieval (embeddings, hybrid search, the confidence gate, the
search tool) unnecessary. The knowledge inventory and the Phase 1 learning note promised to measure
this instead of assuming it.

Phase 7 ran the agent evaluation (42 conversations, deterministic checks and a faithfulness judge)
twice with each design, at `effort: low` (EVALUATION.md, "Retrieval or the whole site in the
prompt"):

| Knowledge                | Passed (warm / cold) | Cost per conversation, warm / cold | Latency p50, warm |
| ------------------------ | -------------------: | ---------------------------------: | ----------------: |
| retrieval (search tool)  |        42/42 / 41/42 |               US$0.00028 / 0.00059 |             3.0 s |
| whole site in the prompt |        42/42 / 42/42 |               US$0.00030 / 0.00104 |             1.9 s |

## Decision

**Keep retrieval as the design.** The whole-site prompt stays available as an evaluation mode
(`pnpm cli eval:agent --knowledge full-context`), not as a production setting.

Reasons, in order:

1. **No quality difference was measured.** Both designs pass the same cases, including all six
   questions the site does not answer.
2. **The site will not stay this small** if the practice adds the content the knowledge base was
   built for (PDFs, curated answers, administrator notes). Retrieval cost stays flat as the
   corpus grows; the whole-site prompt grows with every page.
3. **Quiet traffic favours retrieval.** A doctor's site gets few conversations an hour, and the
   prompt cache lives five minutes, so most conversations start cold. Cold, the whole-site prompt
   costs about 75% more (it writes about 7,500 tokens to the cache instead of about 3,000).
4. **Retrieval leaves a signal.** The best similarity of every search goes to the content-free
   metrics, which show when visitors ask about things the site does not cover.

## Consequences

- The visitor waits about one second longer at the median than with the whole-site prompt. If
  latency becomes the main complaint while the site is still small, switching is a contained
  change: the agent already supports a prompt with fixed source ids (`website` in `Agent`), and the
  production entry would need a SQL function that returns the published chunks.
- The confidence gate is not what keeps the model from inventing answers today (the whole-site
  run had no gate and abstained just as well). The prompt and the model do that; the gate saves
  tokens and adds a metric. Rerun both modes after any change to the prompt, the model or the
  knowledge base.
