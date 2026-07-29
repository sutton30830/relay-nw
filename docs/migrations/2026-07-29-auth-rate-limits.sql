-- Durable, service-role-only password-reset rate limiting. The RPC serializes
-- competing requests for the same email or IP so multiple server instances
-- cannot independently pass the limit.
create table if not exists public.auth_rate_limit_events (
  id bigint generated always as identity primary key,
  action text not null,
  identifier_kind text not null check (identifier_kind in ('email', 'ip')),
  identifier_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists auth_rate_limit_events_lookup_idx
  on public.auth_rate_limit_events (action, identifier_kind, identifier_hash, created_at desc);

alter table public.auth_rate_limit_events enable row level security;

drop policy if exists deny_client_access on public.auth_rate_limit_events;
create policy deny_client_access on public.auth_rate_limit_events
  as restrictive for all to anon, authenticated
  using (false) with check (false);

create or replace function public.consume_auth_rate_limit(
  p_action text,
  p_email_hash text,
  p_ip_hash text,
  p_window_seconds integer,
  p_max_per_email integer,
  p_max_per_ip integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_window_start timestamptz := now() - make_interval(secs => p_window_seconds);
  v_email_lock bigint := hashtextextended(p_action || ':email:' || p_email_hash, 0);
  v_ip_lock bigint := hashtextextended(p_action || ':ip:' || p_ip_hash, 0);
  v_email_count integer;
  v_ip_count integer;
begin
  if
    nullif(trim(p_action), '') is null
    or nullif(trim(p_email_hash), '') is null
    or nullif(trim(p_ip_hash), '') is null
    or p_window_seconds <= 0
    or p_max_per_email <= 0
    or p_max_per_ip <= 0
  then
    raise exception 'Invalid auth rate-limit input';
  end if;

  -- Always acquire the two locks in numeric order to avoid deadlocks between
  -- simultaneous requests sharing an email or an IP.
  perform pg_advisory_xact_lock(least(v_email_lock, v_ip_lock));
  if v_email_lock <> v_ip_lock then
    perform pg_advisory_xact_lock(greatest(v_email_lock, v_ip_lock));
  end if;

  select count(*) into v_email_count
  from public.auth_rate_limit_events
  where action = p_action
    and identifier_kind = 'email'
    and identifier_hash = p_email_hash
    and created_at >= v_window_start;

  select count(*) into v_ip_count
  from public.auth_rate_limit_events
  where action = p_action
    and identifier_kind = 'ip'
    and identifier_hash = p_ip_hash
    and created_at >= v_window_start;

  if v_email_count >= p_max_per_email or v_ip_count >= p_max_per_ip then
    return false;
  end if;

  insert into public.auth_rate_limit_events (action, identifier_kind, identifier_hash)
  values
    (p_action, 'email', p_email_hash),
    (p_action, 'ip', p_ip_hash);

  -- Opportunistic bounded cleanup keeps this security table from growing
  -- forever without placing deletion on the request's critical decision path.
  delete from public.auth_rate_limit_events
  where created_at < now() - interval '7 days';

  return true;
end;
$$;

revoke all on function public.consume_auth_rate_limit(text, text, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_auth_rate_limit(text, text, text, integer, integer, integer)
  to service_role;
