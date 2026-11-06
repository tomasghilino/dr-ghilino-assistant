# ADR 0011: Retrieval service, OR lexical queries and a two-signal confidence gate

Date: 2026-11-05 · Status: accepted · Refines [ADR 0004](0004-hybrid-search-with-rrf-in-sql.md)

## Context

ADR 0004 chose hybrid search fused with RRF in one SQL function. Building it and running the first
retrieval evaluation ([evaluation.md](../evaluation.md)) raised four questions ADR 0004 left
open: how the lexical query treats a whole question, where near-duplicates are removed, how the
retrieved text reaches the model safely, and how to decide that the results are good enough to use.

## Decision

**Lexical query with OR semantics.** `kb_hybrid_search` builds the lexical query with
`plainto_tsquery('spanish', folded_question)` and turns its `&` into `|`. `websearch_to_tsquery` and
`plainto_tsquery` both require every term: "¿cuánto sale la consulta?" would need "sal" and miss
"¿Cuánto cuesta la consulta?". With OR, any term matches and `ts_rank_cd` rewards chunks matching
more terms. The question is accent-folded in TypeScript, like the indexed text.

**One SQL function returns both rankings and both gate signals.** Per row: semantic rank and
similarity, lexical rank, score and coverage, RRF score. For the whole result: the best similarity
and the best lexical coverage. Only chunks of active versions of non-removed documents with the
query's embedding model are searched.

**Near-duplicates are removed in TypeScript, after fusion.** A result whose word 3-grams are at
least 80% inside one better-ranked result is dropped (`RETRIEVAL_DEDUPE_THRESHOLD`), as are exact
hash duplicates. It reuses the shingles of ingestion's deduplication (ADR 0009).

**A two-signal confidence gate.** The question passes when either holds:

- semantic: best cosine similarity ≥ `RETRIEVAL_MIN_SIMILARITY` (0.35);
- lexical: one chunk contains at least `RETRIEVAL_MIN_LEXICAL_COVERAGE` (1.0, all) of the
  question's lexemes.

When it fails, the result is marked `confident: false` and the agent must abstain and offer the
contact channels. The chunks are still returned for debugging and evaluation, never as an answer.

**The threshold policy**, fixed before reading the sweep: fewest false refusals, then fewest false
passes, then the middle of the widest tied interval. Refusing a question the site answers defeats
the purpose of the assistant; passing an unanswerable one still leaves the agent, which only
answers from its sources, to say so.

**Context assembly.** Chunks become `<source id="S1" title="…" url="…">…</source>` blocks in rank
order within `RETRIEVAL_MAX_CONTEXT_TOKENS`. `<` and `>` inside the content are escaped, so a page
cannot close its block or forge another source; the citations `S1…Sn` map to the chunks' URLs.

**Query embeddings are cached** per function instance (LRU, 256 entries, 10 minutes), keyed by a
SHA-256 of model and normalised question, so visitors' questions are not kept as text.

## Alternatives

- **Semantic similarity alone as the gate.** Measured: refusing no answerable question requires a
  threshold of 0.19, which lets 10 of 12 unanswerable questions through. "virrey vertiz 117" (an
  address on the site) scores 0.200, below "¿Cuál es la capital de Francia?" (0.212).
- **A cross-encoder reranker (Voyage rerank) and its relevance score as the gate.** A real
  answerability signal, but another call (~100–300 ms) and another provider dependency. Revisit if
  Phase 7 shows the agent answering from irrelevant chunks.
- **Asking the LLM whether the sources answer the question** before answering. That is what the
  agent's grounded prompt does anyway, in the same call; a separate classification call doubles the
  cost of every question.
- **Semantic ranking only** (drop hybrid). On today's 25 chunks semantic alone ranks better at
  position 1 (100% vs 93.8%) and equally at top 5. Kept hybrid: no loss where it matters (the agent
  reads the top 5), and protection for identifiers as the corpus grows. Revisit with Phase 7 data.
- **Weighted RRF** (more weight to the semantic list). Fixes the two rank-1 losses, but tuning a
  weight on 32 scored questions would be fitting noise.
- **Deduplication in SQL.** Shingle containment is awkward in SQL and the rows are already in memory.

## Consequences

- The evaluation measured 0 of 30 answerable questions refused and 4 of 12 unanswerable ones passed
  (parking, video consultations, hip replacement, a restaurant in San Isidro). The agent's handling
  of those four is a Phase 7 test case.
- The margin is thin (the closest answerable question without full lexical coverage sits at 0.378).
  Every ingestion change should be followed by `pnpm cli eval:retrieval`.
- A one-word question that appears in the site ("turnos", "contacto") always passes the gate. That is
  intended: if the site contains the word, it has something to say about it.
- Changing the return type of `kb_hybrid_search` needs a drop and create (migration
  `20261105220124`), done in the same transaction as the migration.
