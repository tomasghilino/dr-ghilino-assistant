# Dr. Ghilino AI Assistant

A retrieval-augmented (RAG) assistant for https://drluisghilino.com.ar, the practice of
Dr. Luis Antonio Ghilino (Ortopedia y Traumatología, San Miguel and Boulogne). Visitors ask about
offices, hours, appointments, contact channels and the services listed on the site; the assistant
answers in Spanish from verified sources, cites them, says so when it doesn't know, and never gives
medical advice.

It is built as an embeddable widget (one `<script>` tag) on top of a TypeScript backend on InsForge
(Postgres + pgvector, Deno edge functions), with Claude Haiku 5.5 for conversation and Voyage
embeddings for search.

## Status

| Phase                     | State | Notes                                                                                                                             |
| ------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| 0. Discovery and planning | done  | [Architecture](ARCHITECTURE.md), [ADRs](docs/adr), [knowledge inventory](docs/knowledge-inventory.md)                             |
| 1. Foundation             | done  | Workspace, config, schema on InsForge, PGlite and live tests; see [DEPLOYMENT.md](DEPLOYMENT.md)                                  |
| 2. Knowledge ingestion    | done  | 25 chunks + clinic profile on InsForge; see [KNOWLEDGE_BASE.md](KNOWLEDGE_BASE.md)                                                |
| 3. Retrieval engine       | done  | Hybrid search + two-signal gate on InsForge; Recall@5 100%, see [EVALUATION.md](EVALUATION.md)                                    |
| 4. Agent                  | done  | Claude Haiku 5.5, four read-only tools, JSON answer, four safety layers; `pnpm cli chat`                                          |
| 5. Backend API            | done  | Hono API: CORS, limits, budget, encrypted sessions, metrics; bundle runs on Deno; [docs/api.md](docs/api.md)                      |
| 6. Widget                 | done  | 18 KiB, Shadow DOM, text-only rendering, accessible; 10 Chromium e2e tests; [docs/widget.md](docs/widget.md)                      |
| 7. Testing and evaluation | done  | 42-conversation agent evaluation with a faithfulness judge; RAG vs whole-site prompt measured; [EVALUATION.md](EVALUATION.md)     |
| 8. Deployment             | done  | Live on InsForge since 2026-11-06, smoke test 9/9; on the doctor's site via the site repo's PR #5; [DEPLOYMENT.md](DEPLOYMENT.md) |
| 9. Final delivery         | done  | [Walkthrough](docs/WALKTHROUGH.md) and [interview notes](docs/INTERVIEW.md)                                                       |

<p><img src="docs/img/widget-mobile.png" alt="The assistant on a phone, answering that the site does not say whether the doctor works with OSDE and offering WhatsApp" width="300"></p>

## How it works (short version)

1. An admin runs `pnpm ingest`: the CLI fetches the allowlisted pages, splits them into
   heading-aware chunks, embeds them and stores them as a new version in Postgres.
2. A visitor asks a question in the widget. The API checks origin, size and rate limits, redacts
   personal data and catches emergencies before any model call.
3. Claude decides which read-only tool it needs (`search_knowledge`, `get_clinic_information`,
   `get_contact_information`, `get_appointment_information`). Search is hybrid (pgvector + Spanish
   full-text, fused with Reciprocal Rank Fusion) and abstains unless the best match is close in
   meaning or contains every word of the question.
4. The answer comes back as a validated object (text, cited sources, kind). The server checks the
   citations and links before it reaches the visitor.

Details: [ARCHITECTURE.md](ARCHITECTURE.md). Privacy: [PRIVACY.md](PRIVACY.md).

## Quick start

```bash
pnpm install
pnpm verify          # lint + types + tests (no Docker, no API keys needed)
pnpm dev:api         # http://localhost:8787/health
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for the layout and conventions.

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): components, request lifecycle, data model, risks
- [docs/adr](docs/adr): architecture decision records
- [docs/knowledge-inventory.md](docs/knowledge-inventory.md): sources, facts, gaps
- [KNOWLEDGE_BASE.md](KNOWLEDGE_BASE.md): ingestion pipeline and administrator tasks
- [PRIVACY.md](PRIVACY.md): data flows and third-party terms
- [DEVELOPMENT.md](DEVELOPMENT.md): setup and conventions
- [DEPLOYMENT.md](DEPLOYMENT.md): the InsForge project, credentials, migrations
- [docs/learning](docs/learning): notes that explain the AI engineering concepts phase by phase
- [EVALUATION.md](EVALUATION.md): retrieval and agent evaluations, measured results, the test suite
- [SECURITY.md](SECURITY.md): threats, controls and known limitations
- [docs/api.md](docs/api.md): HTTP API reference
- [docs/widget.md](docs/widget.md): install the widget, what it guarantees
- [docs/whatsapp-future.md](docs/whatsapp-future.md): how a WhatsApp channel would plug in
- [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md): the final technical walkthrough, end to end
- [docs/INTERVIEW.md](docs/INTERVIEW.md): a short presentation of the project for interviews
