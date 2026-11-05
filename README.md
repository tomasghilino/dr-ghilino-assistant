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

| Phase                     | State   | Notes                                                                                                 |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| 0. Discovery and planning | done    | [Architecture](ARCHITECTURE.md), [ADRs](docs/adr), [knowledge inventory](docs/knowledge-inventory.md) |
| 1. Foundation             | done    | Workspace, config, schema on InsForge, PGlite and live tests; see [DEPLOYMENT.md](DEPLOYMENT.md)      |
| 2. Knowledge ingestion    | done    | 25 chunks + clinic profile on InsForge; see [KNOWLEDGE_BASE.md](KNOWLEDGE_BASE.md)                    |
| 3. Retrieval engine       | next    |                                                                                                       |
| 4. Agent                  | planned |                                                                                                       |
| 5. Backend API            | planned |                                                                                                       |
| 6. Widget                 | planned |                                                                                                       |
| 7. Testing and evaluation | planned |                                                                                                       |
| 8. Deployment             | planned | Schema and knowledge base are on InsForge; no public endpoint yet.                                    |

## How it works (short version)

1. An admin runs `pnpm ingest`: the CLI fetches the allowlisted pages, splits them into
   heading-aware chunks, embeds them and stores them as a new version in Postgres.
2. A visitor asks a question in the widget. The API checks origin, size and rate limits, redacts
   personal data and catches emergencies before any model call.
3. Claude decides which read-only tool it needs (`search_knowledge`, `get_clinic_information`,
   `get_contact_information`, `get_appointment_information`). Search is hybrid (pgvector + Spanish
   full-text, fused with Reciprocal Rank Fusion) and abstains below a similarity threshold.
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
- Coming with their phases: SECURITY.md, EVALUATION.md, API docs
