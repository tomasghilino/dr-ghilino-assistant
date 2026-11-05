-- Lexical coverage for the confidence gate (ADR 0011).
--
-- The first retrieval evaluation (EVALUATION.md, 2026-11-05) showed that cosine similarity alone
-- cannot tell "virrey vertiz 117" (an address on the site, similarity 0.20) from "¿Cuál es la
-- capital de Francia?" (0.21). Embeddings are weak on identifiers: street numbers, phone numbers,
-- license numbers. Exact terms are what the lexical index is good at, so the function now also
-- reports how much of the question one chunk contains:
--
--   lexical_coverage       share of the question's lexemes (stemmed, stop words removed) found in
--                          this chunk; null when the chunk did not match lexically
--   best_lexical_coverage  the highest lexical_coverage among the lexical candidates
--
-- A question whose every term appears in one chunk passes the gate even with a low similarity.
-- Any unknown term ("domingos", "OSDE", "videollamada") breaks full coverage, which is why this
-- signal does not let unanswerable questions through in the evaluation.
--
-- The return type changes, so the function is dropped and created again (create or replace
-- cannot change the columns of a function).

drop function public.kb_hybrid_search(vector, text, text, integer, integer, integer, jsonb);

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
  lexical_coverage double precision,
  rrf_score double precision,
  best_similarity double precision,
  best_lexical_coverage double precision
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
  -- plainto_tsquery stems and drops Spanish stop words, but joins terms with AND; visitors write
  -- natural language, so any term counts (OR) and ts_rank_cd rewards chunks matching more of them.
  lexical_query as (
    select nullif(replace(plainto_tsquery('spanish', p_query_text)::text, '&', '|'), '')::tsquery as q,
           tsvector_to_array(to_tsvector('spanish', p_query_text)) as lexemes
  ),
  lexical as (
    select ranked.id, ranked.score, ranked.coverage,
           row_number() over (order by ranked.score desc, ranked.id)::integer as rank
    from (
      select s.id, ts_rank_cd(s.fts, lq.q, 1)::double precision as score,
             cardinality(array(select unnest(tsvector_to_array(s.fts))
                               intersect
                               select unnest(lq.lexemes)))::double precision
               / nullif(cardinality(lq.lexemes), 0) as coverage
      from searchable s, lexical_query lq
      where lq.q is not null and s.fts @@ lq.q
      order by score desc, s.id
      limit p_candidates
    ) ranked
  ),
  fused as (
    select coalesce(se.id, le.id) as id,
           se.rank as semantic_rank, se.similarity as semantic_similarity,
           le.rank as lexical_rank, le.score as lexical_score, le.coverage as lexical_coverage,
           coalesce(1.0 / (p_rrf_k + se.rank), 0) + coalesce(1.0 / (p_rrf_k + le.rank), 0) as rrf_score
    from semantic se
    full outer join lexical le on le.id = se.id
  )
  select c.id, d.source_id, d.title, c.anchor_url, c.heading_path, c.content, c.content_hash,
         c.token_estimate, f.semantic_rank, f.semantic_similarity, f.lexical_rank, f.lexical_score,
         f.lexical_coverage, f.rrf_score::double precision,
         (select max(similarity) from semantic)::double precision,
         (select max(coverage) from lexical)::double precision
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
