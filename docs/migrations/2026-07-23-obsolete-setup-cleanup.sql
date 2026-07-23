-- Final cleanup for the two-phase onboarding and Stripe-owned billing model.
-- Run after:
--   1. 2026-07-22-technical-setup-state.sql
--   2. 2026-07-23-atomic-billing-policy.sql

begin;

update public.accounts
set onboarding_status = case
  when onboarding_status in ('activated', 'ready_to_activate') then 'live'
  when onboarding_status = 'waiting_on_customer' then 'waiting_for_forwarding'
  when onboarding_status = 'paused_incomplete' then 'paused'
  when onboarding_status = 'closed_incomplete' then 'closed'
  when onboarding_status in (
    'requirements_needed',
    'ready_for_carrier',
    'carrier_review',
    'carrier_attention',
    'ready_for_live_test'
  ) then 'setting_up'
  else onboarding_status
end
where onboarding_status not in (
  'setting_up',
  'waiting_for_forwarding',
  'live',
  'paused',
  'closed'
);

alter table public.accounts
  drop constraint if exists accounts_onboarding_status_check;

alter table public.accounts
  add constraint accounts_onboarding_status_check
  check (
    onboarding_status in (
      'setting_up',
      'waiting_for_forwarding',
      'live',
      'paused',
      'closed'
    )
  );

drop table if exists public.forwarding_health_checks;

alter table public.accounts
  drop column if exists requirements_due_at,
  drop column if exists stripe_payment_method_id;

alter table if exists public.account_carrier_profiles
  drop column if exists has_ein,
  drop column if exists registration_type,
  drop column if exists registration_id_encrypted,
  drop column if exists registration_id_last4,
  drop column if exists representative_first_name,
  drop column if exists representative_last_name,
  drop column if exists representative_title,
  drop column if exists representative_mobile,
  drop column if exists representative_email,
  drop column if exists messaging_use_case,
  drop column if exists opt_in_flow,
  drop column if exists sample_messages,
  drop column if exists privacy_policy_url,
  drop column if exists terms_url;

commit;

-- Verification:
select
  conname,
  pg_get_constraintdef(oid) as definition
from pg_constraint
where conrelid = 'public.accounts'::regclass
  and conname = 'accounts_onboarding_status_check';

select
  to_regclass('public.forwarding_health_checks') is null as forwarding_health_removed,
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'accounts'
      and column_name in ('requirements_due_at', 'stripe_payment_method_id')
  ) as obsolete_billing_columns_removed;
