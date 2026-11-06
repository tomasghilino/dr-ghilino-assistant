# Presenting the project in an interview

A short version to talk through in 5 to 10 minutes, with the numbers and the trade-offs an
interviewer for a Software Engineer or AI Engineer role is likely to ask about. Everything here is
in the repository; the long version is [WALKTHROUGH.md](WALKTHROUGH.md).

## The 30-second pitch

> I built a production-style RAG assistant for a real doctor's website: an embeddable chat widget
> that answers patients' questions in Spanish about offices, hours, fees and services, cites the
> site, says "the site doesn't say" instead of guessing, never gives medical advice, and sends
> emergencies to 107 / 911 without even calling the model. It's TypeScript end to end: Claude
> Haiku with four read-only tools, hybrid search in Postgres with pgvector, a serverless API on
> InsForge, and an 18 KB widget in a Shadow DOM. I evaluated it with 42 scripted conversations and
> an LLM judge for faithfulness, and I measured whether RAG was even worth it against putting the
> whole site in the prompt.

## The two-minute version: five decisions

1. **Two kinds of knowledge.** Facts with a fixed shape (hours, addresses, fee) come from the site's
   schema.org data, parsed by code into a profile that three tools read. Only free text goes
   through retrieval. Structured facts can't be half-retrieved or paraphrased wrong.
2. **Hybrid search with a two-signal gate.** Embeddings plus Spanish full-text, fused with
   Reciprocal Rank Fusion, in one SQL function. The evaluation showed embeddings score an address
   like "virrey vertiz 117" lower than "what's the capital of France?", so the gate passes on
   semantic similarity **or** full lexical coverage. Zero answerable questions refused.
3. **Agentic loop with a structured final answer.** The model chooses tools, then answers with JSON
   validated against a schema: text, cited source ids, an answer kind (answered, abstained,
   declined_medical, emergency…) and button types. The server turns ids into links and builds the
   buttons, so the model never writes a URL, and abstention becomes a measurable field.
4. **Safety in layers, each cheap and testable.** HTTP limits before anything reads the message; a
   deterministic emergency fast path; PII redaction before any provider sees the text; prompt rules;
   an output guard (uncited answers become abstentions, canary for prompt leaks, link allowlist);
   text-only rendering in the widget. Tools are read-only, so a successful injection can't act.
5. **A runtime-agnostic core.** All the logic is in one package with no Node or Deno types, so the
   same code runs in the Deno function, in Node tests and in the CLI. Tests run on an in-process
   Postgres (PGlite) with every migration, a scripted model and a hashing embedder: free and
   deterministic.

## The numbers

| Metric                                                        | Value                                               |
| ------------------------------------------------------------- | --------------------------------------------------- |
| Retrieval Recall@5 (32 answerable)                            | 100%, MRR 0.961                                     |
| Agent evaluation (42 conversations)                           | 41 or 42 / 42 per run at low effort                 |
| Faithful factual answers (judge)                              | 77 / 80                                             |
| Medical questions declined, injections resisted, prompt leaks | all, all, none                                      |
| Latency (median / p95)                                        | about 3 s / 5 s                                     |
| Cost per conversation (Claude)                                | US$0.0003 warm cache, US$0.0006 cold                |
| Widget                                                        | 18 KiB, no dependencies, axe: no serious violations |
| Tests                                                         | 195 unit + integration, 10 e2e, 4 live              |

## Stories worth telling

**"Most failures were the grader's."** Of six evaluation failures, four were bugs in my own checks:
for example, removing accents to compare text turned "sí" (yes) into "si" (if), so "no puedo
confirmarte si atiende por OSDE" looked like the forbidden "sí, atiende por OSDE". If I had tuned the
prompt to the number, I would have made the assistant worse. I read every failure by hand, fixed the
side that was wrong, and added regression tests for the grader.

**"Is RAG even needed for a 2,500-token site?"** I ran the same 42 conversations with the whole site
in the system prompt. Same quality, one second faster, and it looked 76% more expensive, until I
found the cause: my harness gave every conversation a new random canary, so the prompt cache never
hit. Fixed, the cost was the same with a warm cache, and RAG was cheaper only with a cold one, which
is the normal case for a quiet site. I kept RAG for growth and quiet-traffic cost, and documented the
fallback with numbers (ADR 0015). It also showed the gate isn't what stops the model from inventing:
the prompt is.

**"The free-text identifiers problem."** The confidence gate first used cosine similarity alone,
picked from three observations. The retrieval evaluation showed no single threshold works: to accept
"virrey vertiz 117" it would also accept 10 of 12 unanswerable questions. A second, independent
signal (all the question's terms in one chunk) fixed it with zero false refusals.

## Likely questions

**Why Haiku and not a bigger model?** It's a narrow, grounded task. Haiku at low effort passed the
same cases as medium, at a fraction of a cent, in about 3 seconds. The provider is behind a port and
the model is one environment variable; the evaluation is how I'd justify a change.

**How do you stop hallucinations?** I don't rely on one thing: grounding rules in the prompt, tool
results that state the site's known gaps, a confidence gate, an output guard that downgrades uncited
answers, and an evaluation with a judge that checks every claim against the evidence.

**How do you handle prompt injection?** Retrieved text is escaped data inside `<source>` blocks; the
prompt says it's never instructions; tools are read-only; a canary detects prompt leaks; links can
only come from an allowlist built by the server. Four injection cases are in the evaluation.

**Privacy for a medical site?** No conversation logs. Personal data is redacted before Claude or
Voyage see it. Sessions are AES-GCM encrypted with a key outside the database and expire after 30
idle minutes. Metrics have no column that could hold text.

**Cost control on an anonymous endpoint?** Cheapest checks first (origin, size, schema), per-client
rate limits keyed by an HMAC of the IP, and a daily budget that stops model calls. The prompt cache
cuts input cost by about ten times for the stable part.

**What would you do next?** Deploy and confirm the three platform unknowns; streaming answers; a
scheduled re-ingestion when the site changes; collect real failure cases with the practice; and, if
the practice wants it, WhatsApp, which is a new adapter, not a new agent.

**What would you do differently?** Write the evaluation harness before the prompt, and include the
prompt cache in the measurement from day one.
