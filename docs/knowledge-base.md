# Knowledge base

How the assistant learns what it knows, and how an administrator keeps it current. The rules for
what may be a source are in [docs/knowledge-inventory.md](docs/knowledge-inventory.md).

## What is in it today (2026-11-05)

| Document                                    | Source id   | Chunks | Notes                                                          |
| ------------------------------------------- | ----------- | ------ | -------------------------------------------------------------- |
| https://drluisghilino.com.ar/               | `site-home` | 22     | One chunk per office, pathology, FAQ answer and section intro  |
| https://drluisghilino.com.ar/llms.txt       | `site-llms` | 3      | 9 of its 12 chunks dropped as already covered by the home page |
| Clinic profile (from the home page JSON-LD) | `site-home` | -      | Offices, hours, contact, fee, credentials                      |

Embeddings: Voyage `voyage-4`, 1024 dimensions. Indexing the whole site used 1,878 tokens (free tier).

## The pipeline

```
knowledge/sources.json
  → fetch (https, allowlisted host, timeout, 2 MB cap, text only)
  → extract  HTML: headings, paragraphs, list items, dt/dd, section anchors
             Markdown: headings, paragraphs, list items, quotes
             JSON-LD: clinic profile (validated with zod)
  → chunk    heading-aware: one chunk per smallest headed section, split only if > 400 tokens
  → dedupe   drop chunks already covered by more authoritative sources (3-gram containment ≥ 0.8)
  → hash     extracted content + exact chunk list → version hash; chunk text → chunk hash
  → skip     if the version hash and the pipeline fingerprint match what is published
  → embed    only chunks whose hash has no stored embedding for this model
  → publish  one SQL call: new version + chunks, previous version superseded, atomically
  → remove   documents no longer produced by any enabled source (only after a clean full run)
```

Code: `packages/core/src/ingestion/`. SQL: `migrations/20261105204859_kb-ingestion-functions.sql`.
CLI: `apps/cli/src/commands/ingest.ts`.

### Why these choices

- **Hash the extracted content, not the HTML.** Every rebuild of the Next.js site changes asset
  hashes and class names. Hashing the raw page would re-index on every deploy; hashing what a
  reader reads re-indexes only when the text changes. A test proves a markup-only change is ignored.
- **Heading-aware chunks.** The site's own outline (office, pathology, FAQ answer) matches the
  units visitors ask about, and each heading has an id we can cite (`#consultorio-boulogne`).
  Every chunk starts with its heading path ("Dr. Luis Antonio Ghilino › Consultorios › Boulogne"),
  so a chunk whose body only says "Jueves desde las 17 h" still says which office it is.
- **Sizes.** Sections here are 30 to 170 tokens, so `CHUNK_MAX_TOKENS=400` keeps every one whole.
  `CHUNK_TARGET_TOKENS=220` with `CHUNK_OVERLAP_TOKENS=40` (about 18%) only matters for long future
  documents such as PDFs: it gives one or two paragraphs per chunk, and the overlap keeps a sentence
  that straddles a cut whole in at least one piece.
- **Containment, not pairwise similarity, for duplicates.** llms.txt groups both offices in one list;
  the page has one section per office. No single page chunk resembles the llms.txt list, but together
  they cover 87% of it, which is what containment measures.
- **Embedding reuse by chunk hash.** Changing one paragraph re-embeds one chunk (tested: 1 embedded,
  21 reused). `--force` re-embeds everything, for example after changing the model.
- **The pipeline fingerprint** (pipeline version, chunking settings, dedupe threshold, model,
  dimensions) is stored with each version. Changing any of them re-indexes everything on the next run
  even if the site did not change.

## Administrator tasks

All commands run from the repository root with credentials in `.env.local` (see DEPLOYMENT.md).

| Task                                        | How                                                                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| See what would be indexed, without writing  | `pnpm cli ingest --dry-run` (add `--show-chunks` to print every chunk)                                                                                         |
| Index or refresh after the site changes     | `pnpm cli ingest`. Unchanged documents are skipped.                                                                                                            |
| Re-index one source                         | `pnpm cli ingest --source site-home` (removals are skipped in partial runs)                                                                                    |
| Rebuild everything (new model, new chunker) | `pnpm cli ingest --force`                                                                                                                                      |
| See what is published                       | `pnpm cli kb:list` and `pnpm cli db:status`                                                                                                                    |
| Add a page or a curated Markdown note       | Add an entry to `knowledge/sources.json` (id, https URL, kind, priority), then `pnpm cli ingest`                                                               |
| Remove a document                           | Set `"enabled": false` (or delete the entry) in `sources.json`, then `pnpm cli ingest`                                                                         |
| Recover from a failed run                   | Fix the cause and run `pnpm cli ingest` again. Publishing is atomic per document, so a failed run never leaves half a document; previous versions stay active. |

Rules for new sources:

- Only content the doctor's office has published or approved. A curated note must say who approved
  it and when, in its own text.
- https only, and the host must already be allowlisted by another entry or be added deliberately.
- Lower `priority` wins when two sources say the same thing.
- PDFs are not supported yet (`kind` is `html_page` or `markdown`); convert to Markdown first.

## Run history

Every non-dry run writes one row to `kb_ingestion_runs` with its status and a content-free summary
(outcome, chunk counts, tokens, version per source). A run still marked `running` after an hour is
closed as `failed: abandoned` by the next run.
