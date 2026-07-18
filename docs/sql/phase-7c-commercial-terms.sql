-- Relay NW Phase 7C: setup fee and activation-gated monthly billing.
-- Run this once in Supabase SQL Editor with the service-role-backed app offline
-- or during a quiet deploy. It is idempotent.
--
-- Existing rows are explicitly waived because they predate this commercial
-- model. New accounts default to a $150 setup fee due. Operators can waive a
-- fee for a pilot only through the audited Operations control.

alter table public.accounts add column if not exists setup_fee_cents integer not null default 15000;
alter table public.accounts add column if not exists setup_fee_status text not null default 'due';
alter table public.accounts add column if not exists setup_fee_checkout_session_id text;
alter table public.accounts add column if not exists setup_fee_payment_intent_id text;
alter table public.accounts add column if not exists setup_fee_paid_at timestamptz;
alter table public.accounts add column if not exists setup_fee_waived_at timestamptz;
alter table public.accounts add column if not exists setup_fee_waiver_reason text;
alter table public.accounts add column if not exists monthly_price_cents integer not null default 9900;

alter table public.accounts drop constraint if exists accounts_setup_fee_status_check;
alter table public.accounts add constraint accounts_setup_fee_status_check
  check (setup_fee_status in ('due', 'paid', 'waived', 'refunded'));
alter table public.accounts drop constraint if exists accounts_setup_fee_cents_nonnegative;
alter table public.accounts add constraint accounts_setup_fee_cents_nonnegative
  check (setup_fee_cents >= 0);
alter table public.accounts drop constraint if exists accounts_monthly_price_cents_nonnegative;
alter table public.accounts add constraint accounts_monthly_price_cents_nonnegative
  check (monthly_price_cents >= 0);

create unique index if not exists accounts_setup_fee_checkout_session_unique_idx
  on public.accounts (setup_fee_checkout_session_id)
  where setup_fee_checkout_session_id is not null;
create unique index if not exists accounts_setup_fee_payment_intent_unique_idx
  on public.accounts (setup_fee_payment_intent_id)
  where setup_fee_payment_intent_id is not null;

update public.accounts
set
  setup_fee_status = 'waived',
  setup_fee_waived_at = coalesce(setup_fee_waived_at, now()),
  setup_fee_waiver_reason = coalesce(setup_fee_waiver_reason, 'Pre-commercial account backfill; review before customer billing.')
where setup_fee_status = 'due';

-- Rollback notes:
-- 1. Export affected account rows before rollback if the setup-fee history is
--    needed for audit.
-- 2. Drop the two partial indexes, then drop the eight setup-fee/commercial
--    columns from public.accounts.
-- 3. Do not roll back while a setup-fee Stripe Checkout session is open or
--    while webhook events are being delivered; first disable that price and
--    let outstanding events settle.
