# ADR 0009: Heading-aware chunks with a heading-path prefix; containment-based deduplication

Date: 2026-11-05 · Status: accepted

## Context

The site is one page of short sections (30 to 170 tokens each) with stable anchor ids. llms.txt
restates the same facts with different wording and grouping. Future sources may be long PDFs.

## Decision

- Chunk boundaries follow headings. A section that fits in `CHUNK_MAX_TOKENS` (400) is one chunk; a
  longer one is split on line, then sentence, then word boundaries into pieces of about
  `CHUNK_TARGET_TOKENS` (220) with `CHUNK_OVERLAP_TOKENS` (40) repeated.
- Every chunk starts with its heading path. The same text is embedded, indexed lexically and shown
  to the model.
- Short "eyebrow" lines just before an `h2` ("Consultorios") become the section's label in the path,
  because that is the name visitors and the navigation use.
- A chunk from a lower-priority source is dropped when at least 80% of its word 3-grams already
  appear in higher-priority chunks (containment, not pairwise Jaccard). Exact duplicates are dropped
  regardless of priority.

## Alternatives

- **Fixed-size windows (e.g. 500 tokens with 50 overlap)**: simplest, but would merge the two offices
  into one chunk and cut FAQ answers in half; citations could not point to one section.
- **Merging small sibling sections up to the target size**: fewer, larger chunks, but less precise
  anchors and more unrelated text per retrieved chunk. With a 5-chunk top-K, small precise chunks
  serve "¿y los sábados?" better.
- **Model-generated contextual summaries per chunk** (contextual retrieval): adds an LLM call per chunk
  at ingestion for a corpus whose headings already give the context. Revisit for PDFs.
- **Pairwise near-duplicate detection (Jaccard, MinHash)**: misses a summary that restates several
  sections at once, which is exactly what llms.txt does.

## Consequences

Measured on the live site: 22 chunks from the home page, 3 kept of 12 from llms.txt, all under 180
tokens. The chunker settings are part of the pipeline fingerprint, so changing them re-indexes.
