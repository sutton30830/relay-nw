-- Phase 4: tenant-scoped provider action evidence and atomic retry claims.
-- Additive/idempotent. Existing message, lead, webhook, and Stripe ledgers remain
-- authoritative; this table supplies a common visibility and recovery contract.

create table if not exists public.provider_action_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  action text not null,
  provider text not null check (provider in ('twilio', 'openai', 'resend', 'stripe', 'supabase', 'relay')),
  provider_identifier text,
  resource_type text,
  resource_id text,
  internal_status text not null check (internal_status in ('pending', 'processing', 'accepted', 'succeeded', 'failed', 'suppressed', 'reconciled')),
  provider_status text,
  failure_code text,
  customer_explanation text not null,
  diagnostic_detail text,
  retry_eligibility text not null check (retry_eligibility in ('automatic', 'manual', 'never')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_attempt_at timestamptz not null default now(),
  processing_started_at timestamptz,
  recommended_next_action text not null,
  customer_visible boolean not null default false,
  suppressed boolean not null default false,
  reconciled_at timestamptz,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, idempotency_key)
);

create index if not exists provider_action_account_attempt_idx
  on public.provider_action_events (account_id, last_attempt_at desc);
create index if not exists provider_action_retry_idx
  on public.provider_action_events (internal_status, retry_eligibility, processing_started_at)
  where internal_status in ('failed', 'processing');
create index if not exists provider_action_resource_idx
  on public.provider_action_events (account_id, resource_type, resource_id, last_attempt_at desc);

alter table public.provider_action_events enable row level security;
drop policy if exists deny_client_access on public.provider_action_events;
create policy deny_client_access on public.provider_action_events
  as restrictive for all to anon, authenticated using (false) with check (false);

create or replace function public.record_provider_action_event(
  p_account_id uuid,
  p_action text,
  p_provider text,
  p_idempotency_key text,
  p_provider_identifier text,
  p_resource_type text,
  p_resource_id text,
  p_internal_status text,
  p_provider_status text,
  p_failure_code text,
  p_customer_explanation text,
  p_diagnostic_detail text,
  p_retry_eligibility text,
  p_recommended_next_action text,
  p_customer_visible boolean,
  p_suppressed boolean,
  p_count_attempt boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.provider_action_events (
    account_id, action, provider, idempotency_key, provider_identifier,
    resource_type, resource_id, internal_status, provider_status, failure_code,
    customer_explanation, diagnostic_detail, retry_eligibility,
    recommended_next_action, customer_visible, suppressed, attempt_count,
    last_attempt_at, processing_started_at, reconciled_at
  ) values (
    p_account_id, p_action, p_provider, p_idempotency_key, p_provider_identifier,
    p_resource_type, p_resource_id, p_internal_status, p_provider_status, p_failure_code,
    p_customer_explanation, p_diagnostic_detail, p_retry_eligibility,
    p_recommended_next_action, p_customer_visible, p_suppressed,
    case when p_count_attempt then 1 else 0 end, now(),
    case when p_internal_status = 'processing' then now() else null end,
    case when p_internal_status = 'reconciled' then now() else null end
  )
  on conflict (account_id, idempotency_key) do update set
    action = excluded.action,
    provider = excluded.provider,
    provider_identifier = coalesce(excluded.provider_identifier, provider_action_events.provider_identifier),
    resource_type = coalesce(excluded.resource_type, provider_action_events.resource_type),
    resource_id = coalesce(excluded.resource_id, provider_action_events.resource_id),
    internal_status = case
      when provider_action_events.internal_status in ('accepted', 'succeeded', 'reconciled')
        and excluded.internal_status in ('pending', 'processing')
      then provider_action_events.internal_status
      else excluded.internal_status
    end,
    provider_status = case
      when provider_action_events.internal_status in ('accepted', 'succeeded', 'reconciled')
        and excluded.internal_status in ('pending', 'processing')
      then provider_action_events.provider_status
      else excluded.provider_status
    end,
    failure_code = excluded.failure_code,
    customer_explanation = excluded.customer_explanation,
    diagnostic_detail = excluded.diagnostic_detail,
    retry_eligibility = excluded.retry_eligibility,
    recommended_next_action = excluded.recommended_next_action,
    customer_visible = excluded.customer_visible,
    suppressed = excluded.suppressed,
    attempt_count = provider_action_events.attempt_count + case when p_count_attempt then 1 else 0 end,
    last_attempt_at = now(),
    processing_started_at = case when excluded.internal_status = 'processing' then now() else provider_action_events.processing_started_at end,
    reconciled_at = case when excluded.internal_status = 'reconciled' then now() else provider_action_events.reconciled_at end,
    updated_at = now()
  where not (
    provider_action_events.internal_status = 'succeeded'
    and excluded.internal_status in ('pending', 'processing', 'accepted', 'failed')
  ) and not (
    provider_action_events.internal_status = 'reconciled'
    and excluded.internal_status in ('pending', 'processing', 'accepted')
  )
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.claim_provider_action_retry(
  p_account_id uuid,
  p_idempotency_key text,
  p_stale_before timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  update public.provider_action_events
  set internal_status = 'processing',
      attempt_count = attempt_count + 1,
      last_attempt_at = now(),
      processing_started_at = now(),
      updated_at = now()
  where account_id = p_account_id
    and idempotency_key = p_idempotency_key
    and retry_eligibility in ('automatic', 'manual')
    and (
      (internal_status = 'pending' and attempt_count = 0)
      or (internal_status = 'failed' and action not like '%sms%')
      or (
        internal_status = 'processing'
        and retry_eligibility = 'automatic'
        and action not like '%sms%'
        and processing_started_at < p_stale_before
      )
    )
  returning id into v_id;
  return v_id is not null;
end;
$$;

revoke all on function public.record_provider_action_event(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean,boolean) from public, anon, authenticated;
grant execute on function public.record_provider_action_event(uuid,text,text,text,text,text,text,text,text,text,text,text,text,text,boolean,boolean,boolean) to service_role;
revoke all on function public.claim_provider_action_retry(uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.claim_provider_action_retry(uuid,text,timestamptz) to service_role;
