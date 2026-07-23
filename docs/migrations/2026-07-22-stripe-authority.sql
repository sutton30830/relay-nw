-- Phase 1: make Stripe authoritative for payment/subscription truth while
-- keeping Relay-only commercial exceptions in a separate policy field.
-- Safe to run more than once in the Supabase SQL editor.

alter table public.accounts
  add column if not exists billing_policy text not null default 'standard';
alter table public.accounts
  add column if not exists billing_policy_updated_at timestamptz;

alter table public.accounts drop constraint if exists accounts_billing_policy_check;
alter table public.accounts add constraint accounts_billing_policy_check
  check (billing_policy in ('standard', 'setup_fee_waived', 'comped'));

-- Backfill policy from the legacy mixed-purpose status fields. The old values
-- remain as compatibility shadows during the phased rollout; new code treats
-- billing_policy as authoritative for Relay-granted exceptions.
update public.accounts
set
  billing_policy = 'comped',
  billing_policy_updated_at = coalesce(billing_policy_updated_at, billing_updated_at, now())
where billing_status = 'comped'
  and billing_policy is distinct from 'comped';

update public.accounts
set
  billing_policy = 'setup_fee_waived',
  billing_policy_updated_at = coalesce(billing_policy_updated_at, setup_fee_waived_at, billing_updated_at, now())
where setup_fee_status = 'waived'
  and billing_policy = 'standard';

-- Rollback:
--   alter table public.accounts drop constraint if exists accounts_billing_policy_check;
--   alter table public.accounts drop column if exists billing_policy_updated_at;
--   alter table public.accounts drop column if exists billing_policy;
--
-- Do not remove the legacy `comped` or `waived` status values in this phase.
-- They are compatibility shadows for a rolling deploy and will be removed only
-- after all readers use billing_policy and production rows have been verified.
