-- Ingestion functions: the only way the admin CLI writes to the knowledge base (ADR 0005).
--
-- Every function: lives in public, runs as the caller (SECURITY INVOKER), pins search_path, and is
-- executable by project_admin only. Each call is one transaction, so a document version and its
-- chunks are published together or not at all.

-- Sources come from knowledge/sources.json; the CLI upserts them on every run.
create function public.kb_upsert_source(
  p_id text,
  p_url text,
  p_kind text,
  p_description text,
  p_enabled boolean
)
returns void
language sql
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.kb_sources as s (id, url, kind, description, enabled)
  values (p_id, p_url, p_kind, p_description, p_enabled)
  on conflict (id) do update
    set url = excluded.url,
        kind = excluded.kind,
        description = excluded.description,
        enabled = excluded.enabled,
        updated_at = now()
    where (s.url, s.kind, s.description, s.enabled)
          is distinct from (excluded.url, excluded.kind, excluded.description, excluded.enabled);
$$;

-- Starts a run. A run still "running" after an hour was abandoned (crash, killed terminal):
-- close it as failed so the history stays truthful.
create function public.kb_start_ingestion_run(p_trigger text default 'manual')
returns uuid
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_id uuid;
begin
  update public.kb_ingestion_runs
     set status = 'failed', finished_at = now(), error = 'abandoned: still running after 1 hour'
   where status = 'running' and started_at < now() - interval '1 hour';

  insert into public.kb_ingestion_runs (trigger) values (p_trigger) returning id into v_id;
  return v_id;
end;
$$;

create function public.kb_finish_ingestion_run(
  p_run_id uuid,
  p_status text,
  p_stats jsonb,
  p_error text default null
)
returns void
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_status not in ('succeeded', 'partial', 'failed') then
    raise exception 'invalid final status %', p_status;
  end if;
  update public.kb_ingestion_runs
     set status = p_status, finished_at = now(), stats = coalesce(p_stats, '{}'::jsonb), error = p_error
   where id = p_run_id and status = 'running';
  if not found then
    raise exception 'ingestion run % is not running', p_run_id;
  end if;
end;
$$;

-- What is currently published for a URL, so the pipeline can skip unchanged documents.
create function public.kb_document_state(p_canonical_url text)
returns table (
  document_id uuid,
  version_id uuid,
  version integer,
  content_hash text,
  pipeline_fingerprint text,
  removed boolean
)
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select d.id, v.id, v.version, v.content_hash, v.metadata ->> 'pipeline_fingerprint', d.removed_at is not null
  from public.kb_documents d
  left join public.kb_document_versions v on v.id = d.current_version_id
  where d.canonical_url = p_canonical_url;
$$;

-- Embeddings already computed for identical chunk text with the same model. Re-indexing a page
-- where one paragraph changed re-embeds that paragraph only. Vectors come back as text
-- ("[0.1,...]"), the same representation PostgREST and direct SQL both understand.
create function public.kb_reusable_embeddings(p_content_hashes jsonb, p_model text)
returns table (content_hash text, embedding text)
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select distinct on (c.content_hash) c.content_hash, c.embedding::text
  from public.kb_chunks c
  where c.embedding_model = p_model
    and c.embedding is not null
    and c.content_hash in (select jsonb_array_elements_text(p_content_hashes))
  order by c.content_hash, c.created_at desc;
$$;

-- Publishes a new active version of a document with all its chunks, atomically:
-- upsert the document, supersede the previous active version, insert the new one and its chunks,
-- move the document's pointer. Chunks of versions older than the two latest superseded ones are
-- pruned so the table does not grow forever (the version rows and their text are kept).
create function public.kb_publish_document_version(
  p_source_id text,
  p_document jsonb,
  p_chunks jsonb,
  p_run_id uuid
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_document_id uuid;
  v_version integer;
  v_version_id uuid;
  v_chunk_count integer;
begin
  if jsonb_typeof(p_chunks) is distinct from 'array' or jsonb_array_length(p_chunks) = 0 then
    raise exception 'p_chunks must be a non-empty JSON array';
  end if;

  -- Two concurrent runs publishing the same URL would race on the version number.
  perform pg_advisory_xact_lock(hashtext(p_document ->> 'canonical_url'));

  insert into public.kb_documents as d (source_id, canonical_url, title, language)
  values (
    p_source_id,
    p_document ->> 'canonical_url',
    p_document ->> 'title',
    coalesce(p_document ->> 'language', 'es')
  )
  on conflict (canonical_url) do update
    set source_id = excluded.source_id,
        title = excluded.title,
        language = excluded.language,
        removed_at = null,
        updated_at = now()
  returning d.id into v_document_id;

  select coalesce(max(v.version), 0) + 1 into v_version
  from public.kb_document_versions v
  where v.document_id = v_document_id;

  update public.kb_document_versions
     set status = 'superseded'
   where document_id = v_document_id and status = 'active';

  insert into public.kb_document_versions
    (document_id, version, content_hash, content, metadata, status, ingestion_run_id, fetched_at, indexed_at)
  values (
    v_document_id,
    v_version,
    p_document ->> 'content_hash',
    p_document ->> 'content',
    coalesce(p_document -> 'metadata', '{}'::jsonb),
    'active',
    p_run_id,
    (p_document ->> 'fetched_at')::timestamptz,
    now()
  )
  returning id into v_version_id;

  insert into public.kb_chunks
    (document_version_id, ordinal, heading_path, anchor_url, content, search_text,
     token_estimate, content_hash, embedding, embedding_model)
  select v_version_id, c.ordinal, c.heading_path, c.anchor_url, c.content, c.search_text,
         c.token_estimate, c.content_hash, c.embedding::vector, c.embedding_model
  from jsonb_to_recordset(p_chunks) as c (
    ordinal integer,
    heading_path text[],
    anchor_url text,
    content text,
    search_text text,
    token_estimate integer,
    content_hash text,
    embedding text,
    embedding_model text
  );
  get diagnostics v_chunk_count = row_count;

  update public.kb_documents
     set current_version_id = v_version_id, updated_at = now()
   where id = v_document_id;

  delete from public.kb_chunks
   where document_version_id in (
     select v.id from public.kb_document_versions v
     where v.document_id = v_document_id and v.status = 'superseded'
     order by v.version desc
     offset 2
   );

  return jsonb_build_object(
    'document_id', v_document_id,
    'version_id', v_version_id,
    'version', v_version,
    'chunks', v_chunk_count
  );
end;
$$;

-- sources.json is the source of truth: a published document whose URL is no longer produced by
-- any enabled source is removed from retrieval (its versions stay for the record).
create function public.kb_remove_documents_except(p_keep_urls jsonb)
returns integer
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_removed integer;
begin
  update public.kb_documents d
     set removed_at = now(), current_version_id = null, updated_at = now()
   where d.removed_at is null
     and d.canonical_url not in (select jsonb_array_elements_text(p_keep_urls));
  get diagnostics v_removed = row_count;

  update public.kb_document_versions v
     set status = 'superseded'
    from public.kb_documents d
   where v.document_id = d.id and d.removed_at is not null and v.status = 'active';

  return v_removed;
end;
$$;

-- Structured clinic facts. Publishing an identical profile is a no-op.
create function public.clinic_publish_profile(
  p_profile jsonb,
  p_content_hash text,
  p_source_url text,
  p_run_id uuid
)
returns jsonb
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('clinic_profile'));

  select id into v_id from public.clinic_profiles
   where status = 'active' and content_hash = p_content_hash;
  if found then
    return jsonb_build_object('changed', false, 'id', v_id);
  end if;

  update public.clinic_profiles set status = 'superseded' where status = 'active';
  insert into public.clinic_profiles (profile, content_hash, source_url, status, ingestion_run_id)
  values (p_profile, p_content_hash, p_source_url, 'active', p_run_id)
  returning id into v_id;
  return jsonb_build_object('changed', true, 'id', v_id);
end;
$$;

-- Read-only inventory for `pnpm cli kb:list`. No chunk text.
create function public.kb_inventory()
returns table (
  canonical_url text,
  title text,
  source_id text,
  version integer,
  content_hash text,
  indexed_at timestamptz,
  chunks integer,
  embedding_model text,
  removed boolean
)
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select d.canonical_url, d.title, d.source_id, v.version, v.content_hash, v.indexed_at,
         (select count(*)::integer from public.kb_chunks c where c.document_version_id = v.id),
         (select min(c.embedding_model) from public.kb_chunks c where c.document_version_id = v.id),
         d.removed_at is not null
  from public.kb_documents d
  left join public.kb_document_versions v on v.id = d.current_version_id
  order by d.removed_at nulls first, d.canonical_url;
$$;

revoke execute on function
  public.kb_upsert_source(text, text, text, text, boolean),
  public.kb_start_ingestion_run(text),
  public.kb_finish_ingestion_run(uuid, text, jsonb, text),
  public.kb_document_state(text),
  public.kb_reusable_embeddings(jsonb, text),
  public.kb_publish_document_version(text, jsonb, jsonb, uuid),
  public.kb_remove_documents_except(jsonb),
  public.clinic_publish_profile(jsonb, text, text, uuid),
  public.kb_inventory()
from public, anon, authenticated;

grant execute on function
  public.kb_upsert_source(text, text, text, text, boolean),
  public.kb_start_ingestion_run(text),
  public.kb_finish_ingestion_run(uuid, text, jsonb, text),
  public.kb_document_state(text),
  public.kb_reusable_embeddings(jsonb, text),
  public.kb_publish_document_version(text, jsonb, jsonb, uuid),
  public.kb_remove_documents_except(jsonb),
  public.clinic_publish_profile(jsonb, text, text, uuid),
  public.kb_inventory()
to project_admin;
