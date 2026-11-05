# ADR 0004: Hybrid search (pgvector + Spanish full-text) fused with RRF, in one SQL function

Date: 2026-11-05 · Status: accepted

## Context

Visitors type short, informal queries ("cuanto sale", "obra social", "D'Elia"). Dense vectors catch
paraphrases; exact tokens (street names, "ácido hialurónico", "matrícula") are better served by
lexical search. The InsForge SDK has no full-text helper and no raw SQL.

## Decision

`hybrid_search(query_embedding, query_text, match_count, filters)` in SQL:
cosine top-N over an HNSW index + `websearch_to_tsquery('spanish', folded_text)` top-N, fused with
Reciprocal Rank Fusion (k = 60), restricted to current document versions, deduplicated by chunk
hash. It returns both raw scores so the application can apply a similarity threshold.

## Alternatives

- **Vector only**: simpler, weaker on names and exact terms.
- **Weighted score sum**: needs normalisation of two incomparable scales; RRF does not.
- **Cross-encoder reranker** (Voyage rerank): another call and ~100–300 ms; revisit only if the
  eval shows ranking errors that fusion does not fix.
- **`pg_trgm` fuzzy matching**: not documented on InsForge; accent folding in TypeScript covers
  the common case (missing accents).
