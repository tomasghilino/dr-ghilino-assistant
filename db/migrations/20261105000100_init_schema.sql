-- 20261105000100_init_schema.sql
-- Initial schema for the Dr. Ghilino assistant.
--
-- Conventions (ADR 0005):
--   * Tables live in the private schema `assistant`, which PostgREST does not expose and on
--     which the public roles get no privileges.
--   * Row-level security is enabled on every table with NO policies, as a second barrier.
--   * The application reaches data only through SQL functions in `public` (later migrations),
--     declared SECURITY DEFINER with EXECUTE granted to the admin role only.
--   * Compatible with PostgreSQL 15 (InsForge). Tests run on PGlite (Postgres 18).
--   * No BEGIN/COMMIT: InsForge runs each migration file in its own transaction.

create extension if not exists vector;

-- InsForge already has these roles. Local test databases do not, so create them if missing.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'project_admin') then
    create role project_admin nologin;
  end if;
end
$$;

create schema if not exists assistant;
revoke all on schema assistant from public;

-- Sources: the allowlist of places we ingest from (docs/knowledge-inventory.md).
create table assistant.sources (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  url         text not null unique check (url ~ '^https://'),
  kind        text not null check (kind in ('html_page', 'jsonld', 'markdown', 'pdf', 'text', 'curated')),
  enabled     boolean not null default true,
  description text not null default '',
  created_at  timestamptz not null default now()
);

create table assistant.ingestion_runs (
  id          uuid primary key default gen_random_uuid(),
  trigger     text not null default 'manual' check (trigger in ('manual', 'scheduled', 'ci', 'test')),
  status      text not null default 'running' check (status in ('running', 'succeeded', 'partial', 'failed')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  stats       jsonb not null default '{}'::jsonb,
  error       text,
  check ((status = 'running') = (finished_at is null))
);

-- A logical document (one page section set, one PDF, one curated note).
create table assistant.documents (
  id                 uuid primary key default gen_random_uuid(),
  source_id          text not null references assistant.sources (id) on delete cascade,
  canonical_url      text not null unique check (canonical_url ~ '^https://'),
  title              text not null check (length(title) between 1 and 300),
  language           text not null default 'es',
  current_version_id uuid,
  removed_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Immutable snapshots of a document. Re-ingesting unchanged content creates nothing new.
create table assistant.document_versions (
  id               uuid primary key default gen_random_uuid(),
  document_id      uuid not null references assistant.documents (id) on delete cascade,
  version          integer not null check (version > 0),
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  content          text not null,
  metadata         jsonb not null default '{}'::jsonb,
  status           text not null check (status in ('pending', 'active', 'superseded', 'failed')),
  ingestion_run_id uuid references assistant.ingestion_runs (id) on delete set null,
  fetched_at       timestamptz not null,
  indexed_at       timestamptz,
  created_at       timestamptz not null default now(),
  unique (document_id, version)
);

-- At most one active version per document: retrieval reads only active versions.
create unique index document_versions_one_active
  on assistant.document_versions (document_id)
  where status = 'active';

alter table assistant.documents
  add constraint documents_current_version_fk
  foreign key (current_version_id) references assistant.document_versions (id) on delete set null;

-- Retrieval units. `search_text` is the accent-folded, lowercased text (folded in TypeScript),
-- and `fts` is derived from it, so lexical matching ignores accents on both sides.
create table assistant.chunks (
  id                  uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references assistant.document_versions (id) on delete cascade,
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

create index chunks_embedding_hnsw on assistant.chunks using hnsw (embedding vector_cosine_ops);
create index chunks_fts_gin on assistant.chunks using gin (fts);
create index chunks_content_hash_idx on assistant.chunks (content_hash);
create index chunks_document_version_idx on assistant.chunks (document_version_id);

-- Structured, verified facts used by the clinic tools (offices, hours, contact, fee).
-- Versioned like documents: one active profile at a time.
create table assistant.clinic_profiles (
  id               uuid primary key default gen_random_uuid(),
  profile          jsonb not null,
  content_hash     text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  source_url       text not null check (source_url ~ '^https://'),
  status           text not null check (status in ('active', 'superseded')),
  ingestion_run_id uuid references assistant.ingestion_runs (id) on delete set null,
  created_at       timestamptz not null default now()
);

create unique index clinic_profiles_one_active
  on assistant.clinic_profiles ((status))
  where status = 'active';

-- Short-lived conversation context (ADR 0007). `payload` is AES-GCM ciphertext (base64); the key
-- is a function secret, never stored in the database.
create table assistant.chat_sessions (
  id               uuid primary key,
  channel          text not null check (channel in ('web', 'whatsapp')),
  payload          text not null,
  turn_count       integer not null default 0 check (turn_count >= 0),
  created_at       timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  expires_at       timestamptz not null,
  check (expires_at > created_at)
);

create index chat_sessions_expires_idx on assistant.chat_sessions (expires_at);

-- Fixed-window counters. `bucket_key` is e.g. 'ip:<hmac>:minute'; never a raw IP.
create table assistant.rate_limit_buckets (
  bucket_key   text not null check (length(bucket_key) <= 200),
  window_start timestamptz not null,
  hits         integer not null default 0 check (hits >= 0),
  primary key (bucket_key, window_start)
);

-- Content-free telemetry, one row per API request. No message text, no session id, no IP.
create table assistant.request_metrics (
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

create index request_metrics_occurred_at_idx on assistant.request_metrics (occurred_at);

-- Second barrier: RLS on, no policies → the public roles can read or write nothing,
-- even if a grant is added by mistake.
alter table assistant.sources enable row level security;
alter table assistant.ingestion_runs enable row level security;
alter table assistant.documents enable row level security;
alter table assistant.document_versions enable row level security;
alter table assistant.chunks enable row level security;
alter table assistant.clinic_profiles enable row level security;
alter table assistant.chat_sessions enable row level security;
alter table assistant.rate_limit_buckets enable row level security;
alter table assistant.request_metrics enable row level security;

revoke all on all tables in schema assistant from public, anon, authenticated;

-- Postgres grants EXECUTE on new functions to PUBLIC by default. Turn that off for the
-- functions the later migrations create; each one then grants EXECUTE explicitly.
alter default privileges revoke execute on functions from public;

-- Seed the allowlisted sources from docs/knowledge-inventory.md.
insert into assistant.sources (id, url, kind, description) values
  ('site-home', 'https://drluisghilino.com.ar/', 'html_page', 'Home page: every section of the site'),
  ('site-jsonld', 'https://drluisghilino.com.ar/#jsonld', 'jsonld', 'schema.org data embedded in the home page'),
  ('site-llms', 'https://drluisghilino.com.ar/llms.txt', 'markdown', 'Markdown summary; cross-check, deduplicated against site-home')
on conflict (id) do nothing;
