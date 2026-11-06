# Learning notes: Phase 7, evaluating an assistant

Unit tests answer "does the code do what I wrote?". An evaluation answers a different question:
"does the assistant, with the real model, behave the way a visitor and the doctor need?". The
model is not deterministic and its behaviour is not in our code, so it has to be measured, like a
service's latency.

## 1. Two evaluations, one per layer

| Layer     | Question                                          | Metric                                          | Cost per run |
| --------- | ------------------------------------------------- | ----------------------------------------------- | -----------: |
| Retrieval | Is the answer among the passages we hand over?    | Recall@5, MRR, abstention of the gate (Phase 3) |  ~US$0.00003 |
| Agent     | Is the final reply right, cited, safe and honest? | checks + a judge for faithfulness (Phase 7)     |     ~US$0.10 |

They fail differently. If retrieval misses the passage, no prompt can fix the answer. If retrieval
finds it, the model can still ignore it, mix it up, or add something. Measuring them separately
tells you which half to fix.

## 2. Checks first, a judge only where checks cannot reach

Most of what matters can be checked by code, for free, the same way every time:

- the **kind** of answer (answered, abstained, declined_medical, emergency…): did it abstain on
  "¿Atiende por OSDE?"
- **required facts**: does the fee answer contain "50.000"?
- **forbidden content**: did it say "sí, atiende por OSDE"?
- **citations, links, prompt leaks**.

What code cannot check is **faithfulness**: is every claim in a free-text answer supported by the
evidence the model had? For that, a second model (the **judge**) reads the question, the evidence
(the tool results of that turn) and the answer, lists the claims, and marks each one supported or
not. Two design choices make it trustworthy enough:

- **Claim by claim, and the code decides.** The judge does not get to say "faithful overall"; one
  unsupported claim fails the case.
- **A stronger model judges a cheaper one.** Haiku answers, Sonnet judges. The judge reads only
  about 20 answers per run, so the price difference does not matter.

## 3. Grade the grader

The most useful lesson of this phase: **most failures were the grader's fault.** Of six failures
across four runs, four came from our own checks:

- "no atiende por osde" matched inside "si el Dr. Ghilino **atiende por OSDE**" (missing word
  boundary);
- removing accents to compare text turned "sí" (yes) into "si" (if), so "no puedo confirmarte
  **si atiende**" looked like "**sí, atiende**";
- the judge did not know the widget shows a WhatsApp button, so it called "hay un botón" unsupported.

If we had trusted the number and "fixed" the prompt to pass, we would have made the assistant
worse to satisfy a broken test. The rule: **read every failure by hand before changing anything**,
then fix whichever side is wrong and add a regression test for it. The one failure that was the
assistant's ("the site does not publish closing times", when Saturday has one) stays in the report
as it is.

## 4. A baseline turns opinions into numbers

"Do we even need RAG for a 2,500-token site?" is a fair question. We answered it by running the same
evaluation with the whole site in the prompt and no search tool:

- same quality (42/42 both);
- the whole site is about one second faster (one model call instead of two);
- cost depends on the **prompt cache**: equal when it is warm, 75% more for the whole site when it
  is cold.

Retrieval stays (ADR 0015) for reasons the numbers support (growth, quiet traffic) and one they
revealed: the confidence gate is not what stops the model from inventing; the prompt is.

## 5. Measuring cost honestly: the prompt cache

The first comparison said the whole-site prompt cost 76% more. The cause was in the harness: every
conversation got a random prompt canary, so every system prompt was different and the cache never
hit across conversations. Production uses one configured canary. With one canary per run, the gap
disappeared. Lesson: a measurement is only as good as its resemblance to production, and caching
is part of production.

How the cache works here: the stable part of the request (tool definitions and system prompt) is
marked with `cache_control`. The first call writes it (1.25× the input price); calls in the next five
minutes with the exact same prefix read it (0.1×). Anything that changes per request (today's date)
goes after the marker. One changed character before the marker, like a different canary, means a
new cache entry.

## 6. What an evaluation cannot tell you

- We wrote the questions and the prompt: we test what we imagined. Real visitors will ask other
  things. Questions are not stored (privacy), so new cases come from the practice and from the
  content-free metrics (a rising abstention rate is a signal).
- One run per configuration, with a non-deterministic model: treat ±1 case as noise.
- An abstention that slips in an invented fact is caught only by patterns, not by the judge.

## Commands

```bash
pnpm cli eval:agent                          # 42 conversations, real models, a report in evals/reports
pnpm cli eval:agent --effort medium          # compare effort levels
pnpm cli eval:agent --knowledge full-context # the baseline
pnpm cli eval:agent --only osde --no-judge   # one case, checks only, cheapest
pnpm vitest run packages/core/src/evaluation # the grading logic, offline
```

## Self-check questions

1. Why can't Recall@5 alone tell you whether the assistant's answers are good?
2. The judge says "faithful: true" but marks one claim unsupported. What does the case score, and
   why does the code decide instead of the judge?
3. A check fails. What do you do before touching the prompt?
4. Why did the whole-site prompt look 76% more expensive in the first run, and what does that teach
   about measuring cost?
5. Both designs abstained on every unanswerable question. What does that say about the confidence
   gate's job?
