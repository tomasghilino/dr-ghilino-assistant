-- Initial schema for the Dr. Ghilino assistant.
--
-- Runs as `project_admin` on InsForge (PostgreSQL 15). Conventions (ADR 0005):
--   * App tables live in `public`, as InsForge requires. InsForge grants anon/authenticated
--     SELECT/INSERT/UPDATE/DELETE on every new public table by default, so each table below
--     revokes those privileges explicitly. The browser never talks to these tables.
--   * Row-level security is enabled with NO policies, as a second barrier.
--   * Data is reached only through SQL functions (later migrations), callable by
--     `project_admin`, the role behind the server-side API key.
--   * Postgres 15 features only: tests run on PGlite (Postgres 18) and must not drift.
--   * No BEGIN/COMMIT: InsForge wraps each migration in its own transaction.

create extension if not exists vector;

-- Ingestion runs: one row per `pnpm ingest`, with a report in `stats`.
create table public.kb_ingestion_runs (
  id          uuid primary key default gen_random_uuid(),
  trigger     text not null default 'manual' check (trigger in ('manual', 'scheduled', 'ci', 'test')),
  status      text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  stats       jsonb not null default '{}'::jsonb,
  error       text,
  check ((status = 'running') = (finished_at is null))
);

-- Sources: the allowlist of places we ingest from. Upserted by the ingestion CLI from
-- knowledge/sources.json, so adding a source needs no migration.
create table public.kb_sources (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  url         text not null unique check (url ~ '^https://'),
  kind        text not null check (kind in ('html_page', 'jsonld', 'markdown', 'pdf', 'text', 'curated')),
  enabled     boolean not null default true,
  description text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- A logical document: a web page, a PDF, a curated note.
create table public.kb_documents (
  id                 uuid primary key default gen_random_uuid(),
  source_id          text not null references public.kb_sources (id) on delete cascade,
  canonical_url      text not null unique check (canonical_url ~ '^https://'),
  title              text not null check (length(title) between 1 and 300),
  language           text not null default 'es',
  current_version_id uuid,
  removed_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Immutable snapshots of a document. Re-ingesting unchanged content creates nothing new.
create table public.kb_document_versions (
  id               uuid primary key default gen_random_uuid(),
  document_id      uuid not null references public.kb_documents (id) on delete cascade,
  version          integer not null check (version > 0),
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  content          text not null,
  metadata         jsonb not null default '{}'::jsonb,
  status           text not null check (status in ('pending', 'active', 'superseded', 'failed')),
  ingestion_run_id uuid references public.kb_ingestion_runs (id) on delete set null,
  fetched_at       timestamptz not null,
  indexed_at       timestamptz,
  created_at       timestamptz not null default now(),
  unique (document_id, version)
);

-- At most one active version per document: retrieval reads only active versions.
create unique index kb_document_versions_one_active
  on public.kb_document_versions (document_id)
  where status = 'active';

alter table public.kb_documents
  add constraint kb_documents_current_version_fk
  foreign key (current_version_id) references public.kb_document_versions (id) on delete set null;

-- Retrieval units. `search_text` is the accent-folded, lowercased text (folded in TypeScript),
-- and `fts` derives from it, so lexical matching ignores accents on both sides.
create table public.kb_chunks (
  id                  uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references public.kb_document_versions (id) on delete cascade,
  ordinal             integer not null check (ordinal >= 0),
  heading_path        text[] not null default '{}',
  anchor_url          text not null check (anchor_url ~ '^https://'),
  content             text not null check (length(content) > 0),
  search_text         text not null,
  token_estimate      integer not null check (token_estimate > 0),
  content_hash        text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  embedding           vector(1024),
  embedding_model     text,
  fts                 tsvector generated always as (to_tsvector('spanish', search_text)) stored,
  created_at          timestamptz not null default now(),
  unique (document_version_id, ordinal),
  check ((embedding is null) = (embedding_model is null))
);

create index kb_chunks_embedding_hnsw on public.kb_chunks using hnsw (embedding vector_cosine_ops);
create index kb_chunks_fts_gin on public.kb_chunks using gin (fts);
create index kb_chunks_content_hash_idx on public.kb_chunks (content_hash);
create index kb_chunks_document_version_idx on public.kb_chunks (document_version_id);

-- Structured, verified facts for the clinic tools (offices, hours, contact, fee).
-- Versioned like documents: one active profile at a time.
create table public.clinic_profiles (
  id               uuid primary key default gen_random_uuid(),
  profile          jsonb not null,
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  source_url       text not null check (source_url ~ '^https://'),
  status           text not null check (status in ('active', 'superseded')),
  ingestion_run_id uuid references public.kb_ingestion_runs (id) on delete set null,
  created_at       timestamptz not null default now()
);

create unique index clinic_profiles_one_active
  on public.clinic_profiles ((status))
  where status = 'active';

-- Short-lived conversation context (ADR 0007). `payload` is AES-GCM ciphertext (base64); the
-- key is a function secret and never reaches the database.
create table public.chat_sessions (
  id               uuid primary key,
  channel          text not null check (channel in ('web', 'whatsapp')),
  payload          text not null,
  turn_count       integer not null default 0 check (turn_count >= 0),
  created_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  expires_at       timestamptz not null,
  check (expires_at > created_at)
);

create index chat_sessions_expires_idx on public.chat_sessions (expires_at);

-- Fixed-window counters. `bucket_key` is e.g. 'ip:<hmac>:minute', never a raw IP.
create table public.rate_limit_buckets (
  bucket_key   text not null check (length(bucket_key) <= 200),
  window_start timestamptz not null,
  hits         integer not null default 0 check (hits >= 0),
  primary key (bucket_key, window_start)
);

-- Content-free telemetry, one row per API request. No message text, no session id, no IP.
create table public.request_metrics (
  id                 bigint generated always as identity primary key,
  request_id         uuid not null unique,
  occurred_at        timestamptz not null default now(),
  channel            text not null check (channel in ('web', 'whatsapp', 'internal')),
  route              text not null,
  outcome            text not null check (outcome in (
                       'ok', 'error', 'rate_limited', 'rejected', 'emergency_fast_path', 'budget_exceeded')),
  error_category     text,
  answer_kind        text,
  latency_ms         integer not null check (latency_ms >= 0),
  retrieval_ms       integer,
  llm_ms             integer,
  tool_ms            integer,
  llm_calls          smallint not null default 0,
  tool_calls         text[] not null default '{}',
  model              text,
  input_tokens       integer not null default 0,
  output_tokens      integer not null default 0,
  cache_read_tokens  integer not null default 0,
  cache_write_tokens integer not null default 0,
  embedding_tokens   integer not null default 0,
  estimated_cost_usd numeric(12, 6) not null default 0,
  retrieved_chunks   smallint,
  top_similarity     real
);

create index request_metrics_occurred_at_idx on public.request_metrics (occurred_at);

-- Undo InsForge's default grants to the browser-facing roles, then lock rows with RLS.
revoke all on table
  public.kb_ingestion_runs, public.kb_sources, public.kb_documents, public.kb_document_versions,
  public.kb_chunks, public.clinic_profiles, public.chat_sessions, public.rate_limit_buckets,
  public.request_metrics
from public, anon, authenticated;

revoke all on sequence public.request_metrics_id_seq from public, anon, authenticated;

alter table public.kb_ingestion_runs enable row level security;
alter table public.kb_sources enable row level security;
alter table public.kb_documents enable row level security;
alter table public.kb_document_versions enable row level security;
alter table public.kb_chunks enable row level security;
alter table public.clinic_profiles enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.rate_limit_buckets enable row level security;
alter table public.request_metrics enable row level security;

-- Health probe used by `pnpm cli db:status` and the API's readiness check. Returns counts only.
-- SECURITY INVOKER (the default): it runs with the caller's privileges, so anon, if it ever got
-- EXECUTE, would still hit the revoked tables.
create function public.assistant_status()
returns jsonb
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'postgres', current_setting('server_version'),
    'vector', (select extversion from pg_extension where extname = 'vector'),
    'sources', (select count(*) from public.kb_sources),
    'documents', (select count(*) from public.kb_documents where removed_at is null),
    'active_versions', (select count(*) from public.kb_document_versions where status = 'active'),
    'chunks', (select count(*)
               from public.kb_chunks c
               join public.kb_document_versions v on v.id = c.document_version_id
               where v.status = 'active'),
    'embedding_models', (select coalesce(jsonb_agg(distinct embedding_model), '[]'::jsonb)
                         from public.kb_chunks where embedding_model is not null),
    'has_clinic_profile', exists (select 1 from public.clinic_profiles where status = 'active')
  );
$$;

revoke execute on function public.assistant_status() from public, anon, authenticated;
grant execute on function public.assistant_status() to project_admin;
