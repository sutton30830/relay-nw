-- Repeatable onboarding evidence for a controlled multi-business rollout.
-- Additive and idempotent. This migration records provider/customer evidence;
-- it does not manufacture call, carrier, billing, or launch readiness.

alter table public.account_settings
  add column if not exists forwarding_carrier text;

alter table public.account_settings
  add column if not exists coverage_expectations text;

create table if not exists public.account_onboarding_evidence (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  sms_delivery_verified_at timestamptz,
  sms_delivery_message_sid text,
  non_sms_failure_verified_at timestamptz,
  non_sms_failure_message_sid text,
  non_sms_failure_code text,
  owner_notification_sent_at timestamptz,
  owner_notification_provider_id text,
  owner_notification_confirmed_at timestamptz,
  owner_notification_confirmed_by uuid,
  owner_notification_confirmed_email text,
  customer_go_live_approved_at timestamptz,
  customer_go_live_approved_by uuid,
  customer_go_live_approved_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists account_onboarding_sms_delivery_sid_unique_idx
  on public.account_onboarding_evidence (account_id, sms_delivery_message_sid)
  where sms_delivery_message_sid is not null;

create unique index if not exists account_onboarding_non_sms_failure_sid_unique_idx
  on public.account_onboarding_evidence (account_id, non_sms_failure_message_sid)
  where non_sms_failure_message_sid is not null;

alter table public.account_onboarding_evidence enable row level security;

drop policy if exists deny_client_access on public.account_onboarding_evidence;
create policy deny_client_access on public.account_onboarding_evidence
  as restrictive for all to anon, authenticated
  using (false) with check (false);

comment on table public.account_onboarding_evidence is
  'Tenant-scoped provider and authenticated-customer evidence used to derive onboarding readiness. Operators cannot select an overall readiness state.';
