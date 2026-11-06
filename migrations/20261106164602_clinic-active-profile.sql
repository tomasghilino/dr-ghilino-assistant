-- Read side of the clinic profile (Phase 4). The agent's clinic tools (offices, hours, contact,
-- credentials, fee) read the active profile that ingestion published from the site's schema.org
-- data. Returns null when there is none, so the tools can say so instead of guessing.

create function public.clinic_active_profile()
returns jsonb
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'profile', p.profile,
    'source_url', p.source_url,
    'published_at', p.created_at
  )
  from public.clinic_profiles p
  where p.status = 'active';
$$;

revoke execute on function public.clinic_active_profile() from public, anon, authenticated;
grant execute on function public.clinic_active_profile() to project_admin;
