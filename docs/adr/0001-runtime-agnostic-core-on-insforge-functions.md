# ADR 0001: A runtime-agnostic core, deployed as an InsForge edge function

Date: 2026-11-05 · Status: accepted

## Context

InsForge runs functions on Deno (Deno Deploy subhosting) with the contract
`export default async (req: Request) => Response`. Tests and the admin CLI run on Node.
The widget runs in browsers. We want one implementation of the agent, retrieval and safety
rules for all of them, and later for a WhatsApp channel.

## Decision

- `packages/core` uses only web-standard APIs (`fetch`, `Request`/`Response`, WebCrypto,
  `TextEncoder`) and receives everything else (config, database, LLM, embeddings, clock,
  random) through constructor-injected ports.
- `apps/api` is a Hono app (Hono runs on Deno, Node and Workers). The InsForge entry file reads
  `Deno.env` and builds the dependencies. A Node entry does the same for local development and
  end-to-end tests.
- The function is bundled with esbuild into a single ESM file. Third-party packages stay as
  `npm:` imports, which InsForge documents, so we never ship a minified copy of the Anthropic SDK.

## Alternatives

- **InsForge Custom Compute (containers)**: long-running Node, no timeout worries, but a server
  to size and pay for. Kept as the fallback if function limits turn out too tight.
- **Vercel or Cloudflare for the API**: well known, but the brief asks for InsForge, and it would
  split secrets and logs across two platforms with no measured need.
- **Writing the function directly against Deno APIs**: simplest to deploy, but tests would need
  Deno and the code could not be reused by the Node CLI.

## Consequences

Two small entry files to keep in sync. The bundle must be checked with Deno before deploy
(`npx deno check` in CI, Phase 8).
