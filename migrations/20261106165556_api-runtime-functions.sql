-- Runtime data API for the chat endpoint (Phase 5): rate limits, encrypted sessions, content-free
-- metrics, the daily budget, and cleanup. Same rules as every other function: SECURITY INVOKER,
-- pinned search_path, executable by project_admin only (the role behind the server-side key).

-- Fixed-window rate limiting. One call counts a hit and says whether it is allowed. The key is
-- built by the API from an HMAC of the IP (never the IP itself), e.g. 'ip:<hmac>:minute'.
create function public.rl_hit(p_key text, p_window_seconds integer, p_limit integer)
returns jsonb
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_window timestamptz;
  v_hits integer;
begin
  if p_window_seconds <= 0 or p_limit <= 0 or length(p_key) > 200 then
    raise exception 'invalid rate limit arguments';
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into public.rate_limit_buckets as b (bucket_key, window_start, hits)
  values (p_key, v_window, 1)
  on conflict (bucket_key, window_start) do update set hits = b.hits + 1
  returning b.hits into v_hits;
  return jsonb_build_object(
    'allowed', v_hits <= p_limit,
    'hits', v_hits,
    'reset_at', v_window + make_interval(secs => p_window_seconds)
  );
end;
$$;

-- Sessions (ADR 0007). The payload is ciphertext produced by the API; the database never sees
-- the key. Reads ignore expired rows, so cleanup lag never extends a session.
create function public.session_get(p_id uuid)
returns jsonb
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object('payload', s.payload, 'channel', s.channel, 'turn_count', s.turn_count)
  from public.chat_sessions s
  where s.id = p_id and s.expires_at > now();
$$;

create function public.session_put(
  p_id uuid,
  p_channel text,
  p_payload text,
  p_turn_count integer,
  p_ttl_seconds integer
)
returns void
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_ttl_seconds <= 0 or p_ttl_seconds > 86400 then
    raise exception 'invalid session ttl';
  end if;
  insert into public.chat_sessions as s (id, channel, payload, turn_count, last_activity_at, expires_at)
  values (p_id, p_channel, p_payload, p_turn_count, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (id) do update
    set payload = excluded.payload,
        turn_count = excluded.turn_count,
        last_activity_at = excluded.last_activity_at,
        expires_at = excluded.expires_at
    where s.channel = excluded.channel;
  -- Opportunistic cleanup: a few expired rows per write, so expired text does not wait for the
  -- scheduled job.
  delete from public.chat_sessions
  where ctid in (
    select ctid from public.chat_sessions where expires_at < now() limit 20
  );
end;
$$;

create function public.session_delete(p_id uuid)
returns void
language sql
set search_path = pg_catalog, public, pg_temp
as $$
  delete from public.chat_sessions where id = p_id;
$$;

-- One content-free row per request. Unknown keys in p_row are ignored; there is no column for
-- text, session ids or IPs.
create function public.metrics_record(p_row jsonb)
returns void
language sql
set search_path = pg_catalog, public, pg_temp
as $$
  insert into public.request_metrics (
    request_id, channel, route, outcome, error_category, answer_kind, latency_ms, retrieval_ms,
    llm_ms, tool_ms, llm_calls, tool_calls, model, input_tokens, output_tokens,
    cache_read_tokens, cache_write_tokens, embedding_tokens, estimated_cost_usd,
    retrieved_chunks, top_similarity
  )
  select r.request_id, r.channel, r.route, r.outcome, r.error_category, r.answer_kind,
         r.latency_ms, r.retrieval_ms, r.llm_ms, r.tool_ms, coalesce(r.llm_calls, 0),
         coalesce(r.tool_calls, '{}'), r.model, coalesce(r.input_tokens, 0),
         coalesce(r.output_tokens, 0), coalesce(r.cache_read_tokens, 0),
         coalesce(r.cache_write_tokens, 0), coalesce(r.embedding_tokens, 0),
         coalesce(r.estimated_cost_usd, 0), r.retrieved_chunks, r.top_similarity
  from jsonb_populate_record(null::public.request_metrics, p_row) r;
$$;

-- Estimated spend since midnight in Buenos Aires, for the daily budget circuit breaker.
create function public.budget_spent_today()
returns numeric
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(sum(estimated_cost_usd), 0)
  from public.request_metrics
  where occurred_at >= (date_trunc('day', now() at time zone 'America/Argentina/Buenos_Aires')
                        at time zone 'America/Argentina/Buenos_Aires');
$$;

-- Aggregates for `pnpm cli ops:report`. Counts and sums only.
create function public.metrics_summary(p_days integer default 7)
returns jsonb
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  with recent as (
    select * from public.request_metrics
    where occurred_at >= now() - make_interval(days => greatest(p_days, 1))
  )
  select jsonb_build_object(
    'days', greatest(p_days, 1),
    'requests', (select count(*) from recent),
    'by_outcome', coalesce((select jsonb_object_agg(outcome, n) from
                   (select outcome, count(*) n from recent group by outcome) o), '{}'::jsonb),
    'by_answer_kind', coalesce((select jsonb_object_agg(answer_kind, n) from
                   (select answer_kind, count(*) n from recent where answer_kind is not null
                    group by answer_kind) k), '{}'::jsonb),
    'latency_ms_p50', (select percentile_cont(0.5) within group (order by latency_ms) from recent
                       where route = '/v1/chat' and outcome = 'ok'),
    'latency_ms_p95', (select percentile_cont(0.95) within group (order by latency_ms) from recent
                       where route = '/v1/chat' and outcome = 'ok'),
    'input_tokens', (select coalesce(sum(input_tokens), 0) from recent),
    'output_tokens', (select coalesce(sum(output_tokens), 0) from recent),
    'cache_read_tokens', (select coalesce(sum(cache_read_tokens), 0) from recent),
    'estimated_cost_usd', (select coalesce(sum(estimated_cost_usd), 0) from recent),
    'spent_today_usd', public.budget_spent_today()
  );
$$;

-- Called by an InsForge schedule through the API's maintenance endpoint (ADR 0007).
create function public.maintenance_cleanup(p_metrics_days integer default 90)
returns jsonb
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_sessions integer;
  v_buckets integer;
  v_metrics integer;
begin
  delete from public.chat_sessions where expires_at < now();
  get diagnostics v_sessions = row_count;
  delete from public.rate_limit_buckets where window_start < now() - interval '2 days';
  get diagnostics v_buckets = row_count;
  delete from public.request_metrics
  where occurred_at < now() - make_interval(days => greatest(p_metrics_days, 1));
  get diagnostics v_metrics = row_count;
  return jsonb_build_object('sessions', v_sessions, 'rate_limit_buckets', v_buckets,
                            'metrics', v_metrics);
end;
$$;

revoke execute on function
  public.rl_hit(text, integer, integer),
  public.session_get(uuid),
  public.session_put(uuid, text, text, integer, integer),
  public.session_delete(uuid),
  public.metrics_record(jsonb),
  public.budget_spent_today(),
  public.metrics_summary(integer),
  public.maintenance_cleanup(integer)
from public, anon, authenticated;

grant execute on function
  public.rl_hit(text, integer, integer),
  public.session_get(uuid),
  public.session_put(uuid, text, text, integer, integer),
  public.session_delete(uuid),
  public.metrics_record(jsonb),
  public.budget_spent_today(),
  public.metrics_summary(integer),
  public.maintenance_cleanup(integer)
to project_admin;
