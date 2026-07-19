-- Relay NW billing, onboarding profile, carrier intake, and request acceptance.
-- Safe to run more than once in the Supabase SQL editor.

alter table public.accounts add column if not exists stripe_payment_method_id text;
alter table public.accounts add column if not exists setup_fee_refunded_at timestamptz;
alter table public.accounts add column if not exists setup_fee_refunded_cents integer not null default 0;
alter table public.accounts add column if not exists setup_fee_dispute_status text;

alter table public.accounts drop constraint if exists accounts_setup_fee_status_check;
alter table public.accounts add constraint accounts_setup_fee_status_check
  check (setup_fee_status in ('due', 'paid', 'waived', 'partially_refunded', 'refunded', 'disputed', 'charged_back'));

alter table public.accounts drop constraint if exists accounts_onboarding_status_check;
alter table public.accounts add constraint accounts_onboarding_status_check check (
  onboarding_status in (
    'requirements_needed', 'waiting_on_customer', 'ready_for_carrier',
    'carrier_review', 'carrier_attention', 'ready_for_live_test',
    'ready_to_activate', 'activated', 'paused_incomplete', 'closed_incomplete'
  )
);

alter table public.account_settings add column if not exists owner_name text;
alter table public.account_settings add column if not exists legal_business_name text;
alter table public.account_settings add column if not exists public_business_number text;
alter table public.account_settings add column if not exists business_type text;
alter table public.account_settings add column if not exists business_industry text;
alter table public.account_settings add column if not exists website_url text;
alter table public.account_settings add column if not exists address_line_1 text;
alter table public.account_settings add column if not exists address_line_2 text;
alter table public.account_settings add column if not exists address_city text;
alter table public.account_settings add column if not exists address_region text;
alter table public.account_settings add column if not exists address_postal_code text;
alter table public.account_settings add column if not exists address_country text not null default 'US';
alter table public.account_settings add column if not exists business_hours jsonb;
alter table public.account_settings add column if not exists implementation_notes text;
alter table public.account_settings add column if not exists greeting_preference text not null default 'generated';

create table if not exists public.account_carrier_profiles (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'ready', 'submitted', 'in_progress', 'approved', 'needs_changes', 'rejected')),
  has_ein boolean,
  registration_type text,
  registration_id_encrypted text,
  registration_id_last4 text,
  representative_first_name text,
  representative_last_name text,
  representative_title text,
  representative_mobile text,
  representative_email text,
  messaging_use_case text,
  opt_in_flow text,
  sample_messages text[] not null default '{}',
  privacy_policy_url text,
  terms_url text,
  twilio_brand_sid text,
  twilio_campaign_sid text,
  messaging_service_sid text,
  status_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.account_carrier_profiles enable row level security;
drop policy if exists deny_client_access on public.account_carrier_profiles;
create policy deny_client_access on public.account_carrier_profiles as restrictive for all to public using (false) with check (false);

alter table public.setup_requests add column if not exists business_name text;
alter table public.setup_requests add column if not exists owner_name text;
alter table public.setup_requests add column if not exists owner_email text;
alter table public.setup_requests add column if not exists business_type text;
alter table public.setup_requests add column if not exists public_business_number text;
alter table public.setup_requests add column if not exists account_id uuid references public.accounts(id) on delete set null;
