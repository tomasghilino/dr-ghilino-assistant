# Evaluation

How we measure whether the assistant finds the right information and knows when it has none. Every
number here comes from a report file in [evals/reports](evals/reports); rerun the command to check
it.

Status: the retrieval evaluation exists (Phase 3). The agent evaluation (answer faithfulness,
citations, abstention and safety behaviour of the full conversation) comes in Phase 7.

## Retrieval

### What is measured

```bash
pnpm cli eval:retrieval            # needs .env.local: InsForge admin key and Voyage key
```

The dataset is [evals/retrieval-cases.json](evals/retrieval-cases.json): 47 questions written the
way visitors write (voseo, no accents, typos, one word, slang), in eight categories:

| Category       | Cases | What it checks                                                        |
| -------------- | ----: | --------------------------------------------------------------------- |
| `direct`       |    14 | one fact, asked plainly ("¿Cuánto cuesta la consulta?")               |
| `multi_chunk`  |     5 | two facts from different chunks ("¿cuánto sale y cómo pido turno?")   |
| `ambiguous`    |     5 | one word or no context ("horarios", "¿atiende hoy?")                  |
| `misleading`   |     6 | typos, slang, everyday words ("dolor de cintura", "el cel del dr")    |
| `no_answer`    |     7 | on topic, but the site does not say ("¿Atiende por OSDE?")            |
| `medical`      |     3 | symptoms, doses, a possible fracture: not scored here (Phase 4 rules) |
| `injection`    |     3 | instructions mixed into the question                                  |
| `out_of_scope` |     4 | nothing to do with the practice                                       |

Each case lists **requirement groups** of chunks (by heading path, through short aliases). A group is
met when any one of its chunks is retrieved: the fee is in the FAQ, in the hero and in llms.txt, and
any of them answers the question. A question that needs two facts has two groups.

Each case also says what the **confidence gate** should do: `answer`, `abstain`, or `any` (medical
and two injection cases, where the decision belongs to the safety layer of Phase 4).

Metrics, over the 32 cases with relevant chunks:

- **Hit@K**: at least one relevant chunk in the top K.
- **Recall@K**: share of requirement groups met in the top K. This is the one that matters most: the
  agent reads the top 5, and it can only answer from what it reads.
- **MRR@10** (mean reciprocal rank): 1 / position of the first relevant chunk, averaged. 1.0 means
  always first.

Four rankings are compared for every question, from the same database call:

- `semantic`: pgvector cosine order only;
- `lexical`: Spanish full-text order only;
- `hybrid`: both fused with Reciprocal Rank Fusion, as `kb_hybrid_search` returns them;
- `service`: what the agent will receive (hybrid, near-duplicates dropped, cut to `RETRIEVAL_TOP_K`).

All 47 questions are embedded in one Voyage call (455 tokens, about US$0.00003; within the free
allowance), then every search hits the query cache. The report stores chunk keys, scores and
similarities, never chunk content.

### Results (2026-11-05, voyage-4, 25 chunks)

Report: [evals/reports/retrieval-2026-11-05.json](evals/reports/retrieval-2026-11-05.json).

| Ranking  | Hit@1 | Hit@3 | Hit@5 | Recall@5 | MRR@10 |
| -------- | ----: | ----: | ----: | -------: | -----: |
| semantic |  100% |  100% |  100% |     100% |  1.000 |
| lexical  |   75% | 90.6% | 90.6% |    90.6% |  0.812 |
| hybrid   | 93.8% | 96.9% |  100% |     100% |  0.961 |
| service  | 93.8% | 96.9% |  100% |     100% |  0.961 |

Every answerable question has everything it needs in the top 5, in every category, with the
production path (`service`).

What the numbers say, without spin:

1. **Semantic search alone ranks perfectly on this knowledge base.** Hybrid loses the first position
   twice: "¿Dónde queda el consultorio?" puts the Consultorios overview (no addresses) above the
   Boulogne chunk, and "me pasás el cel del dr?" matches "Dr." lexically in other chunks. Both still
   have the answer in the top 5, so the model reads the same facts.
2. **Lexical search alone is clearly worse** (it cannot connect "cintura" to "columna" or "precio" to
   "valor"), which is why it is never used alone.
3. We keep hybrid ranking anyway (ADR 0011): it costs nothing at top 5, and the corpus will grow with
   identifiers (phone numbers, street names, license numbers) that embeddings handle poorly. This is
   a decision to revisit with Phase 7's larger dataset, not a measured win.

### The confidence gate

Before answering, the retrieval service decides whether the results are good enough to use. The
first version used one signal: the best cosine similarity, with a threshold of 0.35 chosen in Phase 2
from three observations. The evaluation showed that one signal cannot do the job:

| Gate (threshold 0.35)              | Answerable questions refused | Unanswerable questions let through |
| ---------------------------------- | ---------------------------: | ---------------------------------: |
| semantic similarity only           |                         2/30 |                               4/12 |
| semantic **or** full lexical match |                         0/30 |                               4/12 |

Why semantic similarity alone fails, with the measured values:

- "virrey vertiz 117" (the Boulogne address) scores **0.200**, below "¿Cuál es la capital de
  Francia?" at 0.212. Embeddings are bad at identifiers.
- "turnos" scores 0.329: under the threshold, and only 0.016 above "¿Atiende a chicos?" (0.313),
  which the site does not answer.
- "¿Hay estacionamiento cerca del consultorio?" scores 0.456, higher than ten answerable questions.
  Similarity measures how close a question is to a _topic_, not whether the site _answers_ it.
- To refuse no answerable question with similarity alone, the threshold would have to drop to 0.19,
  which lets 10 of 12 unanswerable questions through: no gate at all.

The fix is a second, independent way through: **lexical coverage**, the share of the question's
terms (stemmed, stop words removed) found in a single chunk. "virrey vertiz 117" has coverage 1.0
(all three terms in the Boulogne chunk); "¿Atiende por OSDE?" has 0.5 ("atiende" yes, "osde" no).
In the dataset, no unanswerable question reaches full coverage (the highest is 0.667, "¿Hace
consultas por videollamada?"), because any term the site does not contain breaks it.

The threshold is picked by a policy written before looking at the sweep (ADR 0011): fewest false
refusals first, then fewest false passes, then the middle of the widest interval that achieves both.
The sweep from 0.15 to 0.70 gives:

- semantic only: 0.17–0.19, with 10 unanswerable questions let through;
- semantic or lexical: **0.32–0.37**, midpoint 0.345, with 0 refusals and 4 let through.

So `RETRIEVAL_MIN_SIMILARITY` stays at **0.35** and `RETRIEVAL_MIN_LEXICAL_COVERAGE` is **1**. The
margin is thin: the closest answerable question without full coverage scores 0.378 ("¿En qué
hospitales trabajó?"), only 0.028 above the threshold.

The four unanswerable questions that pass are all close to real topics: parking near the office
(0.456), video consultations (0.416), hip replacement surgery (0.402), a restaurant in San Isidro
(0.396). The gate is not the last line of defence for them: the agent (Phase 4) is told to answer
only what the sources say and to offer the contact channels otherwise. Phase 7 measures whether it
does.

### Latency

From a development machine in Buenos Aires to InsForge in us-east: `kb_hybrid_search` p50 313 ms,
p95 560 ms; the full service call (cached query embedding) p50 328 ms. Almost all of it is the
network round trip; the edge function will run next to the database. A Voyage query embedding took
about 330 ms in a single `pnpm cli search` call.

### Limitations

- 47 questions written by us, not by visitors. The categories and the phrasing try to cover how
  people write, but real traffic will find cases we did not imagine.
- 25 chunks. With so little text, almost every chunk is "near" every question, which inflates the
  similarity of off-topic questions. The numbers will move as the knowledge base grows; rerun the
  evaluation after every ingestion change.
- Relevance labels are ours. They are in the dataset file for anyone to review.
- The gate decision for `any` cases (medical, two injections) is not scored here.

### Reproduce

```bash
pnpm cli search "¿cuánto sale la consulta?" --context   # one question, ranks and model context
pnpm cli eval:retrieval                                # the whole dataset, writes a report
pnpm vitest run packages/core/test/retrieval.int.test.ts # the same runner, offline, on PGlite
```

The offline test uses a hashing stand-in for the embedding model, so its numbers mean nothing; it
proves the runner, the aliases and the report format, and that every alias names a chunk that
exists in the indexed site.
