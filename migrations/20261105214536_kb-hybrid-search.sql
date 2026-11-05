-- Hybrid retrieval (ADR 0004): semantic (pgvector cosine) + lexical (Spanish full-text), fused with
-- Reciprocal Rank Fusion. One function so the database does the ranking and only the winners
-- travel over the network.
--
-- Inputs come from the retrieval service:
--   p_query_embedding  the visitor's question embedded with input_type "query"
--   p_query_text       the same question accent-folded in TypeScript (the index is folded too)
--   p_embedding_model  only vectors from this model are compared
--   p_match_count      rows to return after fusion
--   p_candidates       how deep each of the two lists goes before fusion
--   p_rrf_k            RRF constant (60 in the original paper)
--   p_source_ids       optional JSON array of source ids to search (metadata filter)
--
-- Only chunks of active versions of non-removed documents are searched: an outdated version can
-- never be retrieved.

create function public.kb_hybrid_search(
  p_query_embedding vector(1024),
  p_query_text text,
  p_embedding_model text,
  p_match_count integer default 10,
  p_candidates integer default 20,
  p_rrf_k integer default 60,
  p_source_ids jsonb default null
)
returns table (
  chunk_id uuid,
  source_id text,
  document_title text,
  anchor_url text,
  heading_path text[],
  content text,
  content_hash text,
  token_estimate integer,
  semantic_rank integer,
  semantic_similarity double precision,
  lexical_rank integer,
  lexical_score double precision,
  rrf_score double precision,
  best_similarity double precision
)
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  with searchable as (
    select c.id, c.embedding, c.fts
    from public.kb_chunks c
    join public.kb_document_versions v on v.id = c.document_version_id and v.status = 'active'
    join public.kb_documents d on d.id = v.document_id and d.removed_at is null
    where c.embedding_model = p_embedding_model
      and (p_source_ids is null
           or d.source_id in (select jsonb_array_elements_text(p_source_ids)))
  ),
  semantic as (
    select ranked.id, ranked.similarity,
           row_number() over (order by ranked.distance, ranked.id)::integer as rank
    from (
      select s.id, s.embedding <=> p_query_embedding as distance,
             1 - (s.embedding <=> p_query_embedding) as similarity
      from searchable s
      order by s.embedding <=> p_query_embedding, s.id
      limit p_candidates
    ) ranked
  ),
  -- plainto_tsquery stems and drops Spanish stop words, but joins terms with AND: "¿cuánto sale la
  -- consulta?" would then require "sal" in the chunk and miss "¿Cuánto cuesta la consulta?".
  -- Visitors' questions are natural language, so any term counts (OR) and ts_rank_cd rewards
  -- chunks that match more of them.
  lexical_query as (
    select nullif(replace(plainto_tsquery('spanish', p_query_text)::text, '&', '|'), '')::tsquery as q
  ),
  lexical as (
    select ranked.id, ranked.score,
           row_number() over (order by ranked.score desc, ranked.id)::integer as rank
    from (
      select s.id, ts_rank_cd(s.fts, lq.q, 1)::double precision as score
      from searchable s, lexical_query lq
      where lq.q is not null and s.fts @@ lq.q
      order by score desc, s.id
      limit p_candidates
    ) ranked
  ),
  fused as (
    select coalesce(se.id, le.id) as id,
           se.rank as semantic_rank, se.similarity as semantic_similarity,
           le.rank as lexical_rank, le.score as lexical_score,
           coalesce(1.0 / (p_rrf_k + se.rank), 0) + coalesce(1.0 / (p_rrf_k + le.rank), 0) as rrf_score
    from semantic se
    full outer join lexical le on le.id = se.id
  )
  select c.id, d.source_id, d.title, c.anchor_url, c.heading_path, c.content, c.content_hash,
         c.token_estimate, f.semantic_rank, f.semantic_similarity, f.lexical_rank, f.lexical_score,
         f.rrf_score::double precision,
         (select max(similarity) from semantic)::double precision
  from fused f
  join public.kb_chunks c on c.id = f.id
  join public.kb_document_versions v on v.id = c.document_version_id
  join public.kb_documents d on d.id = v.document_id
  order by f.rrf_score desc, f.semantic_rank nulls last, c.id
  limit p_match_count;
$$;

revoke execute on function public.kb_hybrid_search(vector, text, text, integer, integer, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.kb_hybrid_search(vector, text, text, integer, integer, integer, jsonb)
  to project_admin;
