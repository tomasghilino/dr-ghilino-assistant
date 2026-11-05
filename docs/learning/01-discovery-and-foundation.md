# Learning notes: Phases 0 and 1

These notes explain the concepts behind the decisions, using this project's data. Each later
phase adds its own file.

## 1. What an LLM API call really is

`POST /v1/messages` is **stateless**. Claude does not remember the previous request. Every call
sends everything the model should consider:

```text
system:   who you are, rules (scope, no medical advice, cite sources, Spanish "vos")
tools:    JSON schemas of the functions the model may ask us to run
messages: [user: "¿Atiende los sábados?", assistant: "...", user: "¿y en San Miguel?"]
```

The model reads all of that as **tokens** (pieces of words; Spanish averages about 3.6 characters
per token) and produces tokens. You pay per token in and per token out. With Haiku 5.5 that is
$0.10 per million input tokens and $0.50 per million output tokens.

The **context window** is the maximum number of tokens in one call (1M for Haiku 5.5). It sounds
huge, but more context is slower, costs more and dilutes attention. That is why we send the last
6 turns, not the whole conversation, and about 2,000 tokens of retrieved text, not the whole
knowledge base.

"Memory" across turns is our job. That is the reason `chat_sessions` exists: the API keeps the
last turns, encrypted, and replays them on the next call.

## 2. Tool calling (preview of Phase 4)

A tool is a function **we** run. The model never executes anything. The model only answers with a
structured request:

```json
{ "type": "tool_use", "name": "search_knowledge", "input": { "query": "horarios sábado Boulogne" } }
```

Our code validates the input, runs the search, and sends back a `tool_result`. Then the model
writes the final answer. The model chose the tool because the tool's `description` and the system
prompt told it when to. That is the whole mechanism: instructions plus schemas, read by a model
that was trained to emit those blocks. It is also why tools must be read-only here. If a prompt
injection fools the model, the worst it can do is call a search.

## 3. RAG compared with "put the whole site in the prompt"

Our site is about 2,500 tokens. Stuffing it into every call would cost about $0.00025 per call and
work fine _today_. We build retrieval anyway, and say so honestly (knowledge inventory, last
section):

- **Growth.** PDFs and curated notes would make "send everything" slow and expensive.
- **Citations.** We know exactly which chunk supported an answer, so the widget can link to
  `#consultorio-boulogne`.
- **Abstention.** A retrieval score gives a measurable signal ("nothing relevant found") to say "no
  sé" instead of improvising.
- **Measurement.** Phase 7 runs a full-context baseline next to RAG, so the trade-off is a number.

## 4. Embeddings and vector similarity

An embedding model turns text into a vector, here **1024 numbers**, such that texts with similar
meaning get vectors pointing in similar directions. "¿Cuánto sale la consulta?" and "Valor de la
consulta: $50.000" share almost no words, but their vectors are close.

"Close" is measured with **cosine similarity**, the cosine of the angle between two vectors: 1
means the same direction, 0 means unrelated. pgvector's `<=>` operator returns _cosine distance_
(`1 − similarity`), so lower is closer. The schema test checks that a vector has distance 0 from
itself.

Voyage has two **input types**. A document is embedded with `input_type: "document"` and a question
with `input_type: "query"`. The model was trained so that questions land near the passages that
answer them, which is not the same as being near similar questions.

The column is `vector(1024)`. Postgres rejects any other size, so switching to a model with a
different size fails loudly instead of silently mixing incompatible vectors (a schema test checks
this). We also store `embedding_model` per chunk, because vectors from two different models are not
comparable even when they have the same size.

## 5. Why hybrid search, and what RRF does

Vectors are good at meaning and weaker at exact tokens: "D'Elía 1367", "matrícula 445565", "ácido
hialurónico". Classic full-text search is the opposite. We run both and **fuse** them.

Reciprocal Rank Fusion ignores the raw scores, which live on different scales, and uses ranks
only:

```text
score(chunk) = Σ over each search list   1 / (k + rank_in_that_list)      with k = 60
```

Example for "obra social Boulogne". Vector search ranks the Boulogne office chunk 1st and the FAQ
"¿Hace falta sacar turno?" 2nd. Full-text ranks the FAQ 1st (it contains "Boulogne" and "consulta")
and the office chunk 3rd.

- Office: 1/61 + 1/63 = 0.0323
- FAQ: 1/62 + 1/61 = 0.0325

The FAQ edges ahead because both lists agreed it was relevant. k = 60 is the value from the
original paper; it damps the advantage of a single first place.

Note that **neither** chunk mentions obras sociales. Fusion ranks; it does not judge relevance.
That is why we also need the similarity **threshold** and the instruction to abstain.

## 6. Accent folding

Visitors type "Vertiz", "Delia", "sabados". We store `search_text` lowercased and without
diacritics, and fold the query the same way, so both sides meet. We do it in TypeScript
(`foldForSearch`) because InsForge does not document the `unaccent` extension. One function, unit
tested, works on every runtime.

## 7. Architecture ideas used in Phase 1

- **Ports and adapters.** The core declares _what_ it needs (`RpcClient`, later `LlmProvider` and
  `EmbeddingProvider`). Entry files decide _which_ implementation to use: InsForge `rpc()` in
  production, PGlite in tests, Anthropic for real, a scripted fake in tests. That is how the same
  agent will serve the widget today and WhatsApp later.
- **Runtime boundary enforced by the compiler.** `packages/core` is type-checked without Node
  types, so `process.env` there is a compile error, not a Deno crash in production.
- **Database as a security boundary.** Tables sit in a schema PostgREST does not expose, with RLS on
  and no policies. The public anon key can reach nothing. The only door is a set of SQL functions
  that only the admin role may execute. The integration test proves `anon` gets "permission denied".
- **Config validation at the edge.** zod parses env vars once, applies defaults and reports _names_
  of bad variables, never values, so a misconfigured secret never lands in a log.
- **Real database in tests.** PGlite runs Postgres 18 in WebAssembly inside the test process. The
  tests run the real migrations, real pgvector and the real Spanish text search, with no Docker and
  no mocks.

## Self-check questions

1. Why does the API have to send the previous turns on every call?
2. A visitor asks "¿atienden por PAMI?". Which component should stop the assistant from inventing an
   answer, and what signal does it use?
3. Why can't we compare a Voyage vector with an OpenAI vector, even at 1024 dimensions?
4. In RRF, what happens to a chunk that only one of the two searches found?
5. What stops someone with the public anon key from reading `assistant.chunks` directly?
