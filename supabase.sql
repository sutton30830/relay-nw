create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  billing_status text not null default 'not_started' check (
    billing_status in ('not_started', 'trialing', 'active', 'past_due', 'canceled', 'comped')
  ),
  billing_policy text not null default 'standard' check (
    billing_policy in ('standard', 'setup_fee_waived', 'comped')
  ),
  billing_policy_updated_at timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  stripe_payment_method_id text,
  stripe_subscription_status text,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  onboarding_status text not null default 'setting_up' check (
    onboarding_status in (
      'setting_up',
      'waiting_for_forwarding',
      'live',
      'paused',
      'closed',
      'requirements_needed',
      'waiting_on_customer',
      'ready_for_carrier',
      'carrier_review',
      'carrier_attention',
      'ready_for_live_test',
      'ready_to_activate',
      'activated',
      'paused_incomplete',
      'closed_incomplete'
    )
  ),
  onboarding_status_updated_at timestamptz,
  requirements_due_at timestamptz,
  activated_at timestamptz,
  first_paid_at timestamptz,
  guarantee_ends_at timestamptz,
  billing_attention_since timestamptz,
  billing_updated_at timestamptz,
  setup_fee_cents integer not null default 15000 check (setup_fee_cents >= 0),
  setup_fee_status text not null default 'due' check (setup_fee_status in ('due', 'paid', 'waived', 'partially_refunded', 'refunded', 'disputed', 'charged_back')),
  setup_fee_checkout_session_id text,
  setup_fee_payment_intent_id text,
  setup_fee_paid_at timestamptz,
  setup_fee_waived_at timestamptz,
  setup_fee_waiver_reason text,
  setup_fee_refunded_at timestamptz,
  setup_fee_refunded_cents integer not null default 0 check (setup_fee_refunded_cents >= 0),
  setup_fee_dispute_status text,
  monthly_price_cents integer not null default 9900 check (monthly_price_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.accounts add column if not exists billing_status text not null default 'not_started';
alter table public.accounts add column if not exists billing_policy text not null default 'standard';
alter table public.accounts add column if not exists billing_policy_updated_at timestamptz;
alter table public.accounts add column if not exists stripe_customer_id text;
alter table public.accounts add column if not exists stripe_subscription_id text;
alter table public.accounts add column if not exists stripe_price_id text;
alter table public.accounts add column if not exists stripe_payment_method_id text;
alter table public.accounts add column if not exists stripe_subscription_status text;
alter table public.accounts add column if not exists trial_ends_at timestamptz;
alter table public.accounts add column if not exists current_period_end timestamptz;
alter table public.accounts add column if not exists cancel_at_period_end boolean not null default false;
alter table public.accounts add column if not exists onboarding_status text not null default 'setting_up';
alter table public.accounts alter column onboarding_status set default 'setting_up';
alter table public.accounts add column if not exists onboarding_status_updated_at timestamptz;
alter table public.accounts add column if not exists requirements_due_at timestamptz;
alter table public.accounts add column if not exists activated_at timestamptz;
alter table public.accounts add column if not exists first_paid_at timestamptz;
alter table public.accounts add column if not exists guarantee_ends_at timestamptz;
alter table public.accounts add column if not exists billing_attention_since timestamptz;
alter table public.accounts add column if not exists billing_updated_at timestamptz;
alter table public.accounts add column if not exists setup_fee_cents integer not null default 15000;
alter table public.accounts add column if not exists canceled_at timestamptz;
alter table public.accounts add column if not exists setup_fee_status text not null default 'due';
alter table public.accounts add column if not exists setup_fee_checkout_session_id text;
alter table public.accounts add column if not exists setup_fee_payment_intent_id text;
alter table public.accounts add column if not exists setup_fee_paid_at timestamptz;
alter table public.accounts add column if not exists setup_fee_waived_at timestamptz;
alter table public.accounts add column if not exists setup_fee_waiver_reason text;
alter table public.accounts add column if not exists setup_fee_refunded_at timestamptz;
alter table public.accounts add column if not exists setup_fee_refunded_cents integer not null default 0;
alter table public.accounts add column if not exists setup_fee_dispute_status text;
alter table public.accounts add column if not exists monthly_price_cents integer not null default 9900;
do $$
begin
  alter table public.accounts
    add constraint accounts_billing_status_check
    check (billing_status in ('not_started', 'trialing', 'active', 'past_due', 'canceled', 'comped'));
exception
  when duplicate_object then null;
end $$;
do $$
begin
  alter table public.accounts drop constraint if exists accounts_billing_policy_check;
  alter table public.accounts
    add constraint accounts_billing_policy_check
    check (billing_policy in ('standard', 'setup_fee_waived', 'comped'));
exception
  when duplicate_object then null;
end $$;
do $$
begin
  alter table public.accounts drop constraint if exists accounts_onboarding_status_check;
  alter table public.accounts
    add constraint accounts_onboarding_status_check
    check (
      onboarding_status in (
        'setting_up',
        'waiting_for_forwarding',
        'live',
        'paused',
        'closed',
        'requirements_needed',
        'waiting_on_customer',
        'ready_for_carrier',
        'carrier_review',
        'carrier_attention',
        'ready_for_live_test',
        'ready_to_activate',
        'activated',
        'paused_incomplete',
        'closed_incomplete'
      )
    );
exception
  when duplicate_object then null;
end $$;
do $$
begin
  alter table public.accounts
    add constraint accounts_stripe_subscription_status_check
    check (
      stripe_subscription_status is null or
      stripe_subscription_status in (
        'incomplete',
        'incomplete_expired',
        'trialing',
        'active',
        'past_due',
        'canceled',
        'unpaid',
        'paused'
      )
    );
exception
  when duplicate_object then null;
end $$;
create unique index if not exists accounts_stripe_customer_id_unique_idx
  on public.accounts (stripe_customer_id)
  where stripe_customer_id is not null;
create unique index if not exists accounts_stripe_subscription_id_unique_idx
  on public.accounts (stripe_subscription_id)
  where stripe_subscription_id is not null;
create unique index if not exists accounts_setup_fee_checkout_session_unique_idx
  on public.accounts (setup_fee_checkout_session_id)
  where setup_fee_checkout_session_id is not null;
create unique index if not exists accounts_setup_fee_payment_intent_unique_idx
  on public.accounts (setup_fee_payment_intent_id)
  where setup_fee_payment_intent_id is not null;

do $$
begin
  alter table public.accounts drop constraint if exists accounts_setup_fee_status_check;
  alter table public.accounts
    add constraint accounts_setup_fee_status_check
    check (setup_fee_status in ('due', 'paid', 'waived', 'partially_refunded', 'refunded', 'disputed', 'charged_back'));
exception
  when duplicate_object then null;
end $$;

-- Phase 7C commercial terms.
-- Existing accounts are pre-commercial pilot/house accounts. Preserve their
-- current behavior by explicitly waiving the new setup fee, with an audit note
-- available for operators to review. New accounts retain the default 'due'.
update public.accounts
set
  setup_fee_status = 'waived',
  setup_fee_waived_at = coalesce(setup_fee_waived_at, now()),
  setup_fee_waiver_reason = coalesce(setup_fee_waiver_reason, 'Pre-commercial account backfill; review before customer billing.')
where setup_fee_status = 'due'
  and created_at < timestamptz '2026-07-01 00:00:00+00';

-- Phase 1 Stripe-authority boundary. Relay exceptions are policy, not Stripe
-- payment/subscription states. Legacy mixed-purpose values remain as rolling-
-- deploy compatibility shadows until the later cleanup phase.
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

alter table public.accounts enable row level security;

-- Phase 5C billing lifecycle migration.
-- Rollback, if ever needed before durable Stripe webhook processing is live:
--   drop table public.stripe_events;
-- If rolling back only the Phase 5C3 event-claim additions:
--   drop index if exists public.stripe_events_processing_status_idx;
--   alter table public.stripe_events drop column if exists processing_started_at;
--   alter table public.stripe_events drop column if exists ignore_reason;
-- Broader Phase 5C rollback:
--   alter table public.accounts drop constraint if exists accounts_stripe_subscription_status_check;
--   alter table public.accounts drop constraint if exists accounts_onboarding_status_check;
--   alter table public.accounts drop column if exists billing_attention_since;
--   alter table public.accounts drop column if exists guarantee_ends_at;
--   alter table public.accounts drop column if exists first_paid_at;
--   alter table public.accounts drop column if exists activated_at;
--   alter table public.accounts drop column if exists requirements_due_at;
--   alter table public.accounts drop column if exists onboarding_status_updated_at;
--   alter table public.accounts drop column if exists onboarding_status;
--   alter table public.accounts drop column if exists cancel_at_period_end;
--   alter table public.accounts drop column if exists current_period_end;
--   alter table public.accounts drop column if exists stripe_subscription_status;
-- Keep billing_status/customer/subscription/price/trial/billing_updated_at because
-- those are already used by the existing checkout and webhook paths.
create table if not exists public.stripe_events (
  event_id text primary key,
  event_type text not null,
  event_created_at timestamptz,
  livemode boolean not null default false,
  account_id uuid references public.accounts(id) on delete set null,
  stripe_customer_id text,
  stripe_subscription_id text,
  processing_status text not null default 'received' check (
    processing_status in ('received', 'processing', 'processed', 'ignored', 'failed')
  ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  error_code text,
  ignore_reason text,
  processing_started_at timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
alter table public.stripe_events add column if not exists ignore_reason text;
alter table public.stripe_events add column if not exists processing_started_at timestamptz;
create index if not exists stripe_events_account_received_at_idx
  on public.stripe_events (account_id, received_at desc)
  where account_id is not null;
create index if not exists stripe_events_subscription_idx
  on public.stripe_events (stripe_subscription_id)
  where stripe_subscription_id is not null;
create index if not exists stripe_events_customer_idx
  on public.stripe_events (stripe_customer_id)
  where stripe_customer_id is not null;
create index if not exists stripe_events_processing_status_idx
  on public.stripe_events (processing_status, processing_started_at);
alter table public.stripe_events enable row level security;

create table if not exists public.account_settings (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  business_name text not null,
  owner_email text,
  owner_name text,
  legal_business_name text,
  public_business_number text,
  business_type text,
  business_industry text,
  website_url text,
  address_line_1 text,
  address_line_2 text,
  address_city text,
  address_region text,
  address_postal_code text,
  address_country text not null default 'US',
  business_hours jsonb,
  implementation_notes text,
  greeting_preference text not null default 'generated' check (greeting_preference in ('generated', 'recorded')),
  owner_phone_number text not null,
  intake_url text not null,
  scheduling_url text,
  call_mode text not null default 'forwarding' check (call_mode in ('direct', 'forwarding')),
  sms_enabled boolean not null default false,
  sms_template text,
  quick_reply_templates text[],
  missed_call_voice_message text,
  missed_call_voice_name text not null default 'Polly.Joanna-Neural',
  missed_call_greeting_audio_url text,
  voicemail_max_seconds integer not null default 60 check (voicemail_max_seconds > 0),
  dial_timeout_seconds integer not null default 18 check (dial_timeout_seconds > 0),
  missed_call_sms_cooldown_hours integer not null default 24 check (missed_call_sms_cooldown_hours > 0),
  typical_job_value_cents integer check (typical_job_value_cents is null or typical_job_value_cents >= 0),
  voicemail_transcription_enabled boolean not null default true,
  a2p_registration_status text not null default 'not_started' check (
    a2p_registration_status in ('not_started', 'in_progress', 'approved', 'needs_attention', 'rejected', 'paused')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.account_settings add column if not exists owner_email text;
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
alter table public.account_settings drop constraint if exists account_settings_a2p_registration_status_check;
alter table public.account_settings
  add constraint account_settings_a2p_registration_status_check
  check (
    a2p_registration_status in (
      'not_started',
      'in_progress',
      'approved',
      'needs_attention',
      'rejected',
      'paused'
    )
  );
alter table public.account_settings add column if not exists greeting_preference text not null default 'generated';
alter table public.account_settings add column if not exists quick_reply_templates text[];
alter table public.account_settings add column if not exists typical_job_value_cents integer;
alter table public.account_settings drop constraint if exists account_settings_typical_job_value_cents_nonnegative;
alter table public.account_settings
  add constraint account_settings_typical_job_value_cents_nonnegative
  check (typical_job_value_cents is null or typical_job_value_cents >= 0);

alter table public.account_settings enable row level security;

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

create table if not exists public.account_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  phone_number text not null unique,
  label text,
  is_primary boolean not null default false,
  twilio_sid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists account_phone_numbers_account_id_idx
  on public.account_phone_numbers (account_id);

alter table public.account_phone_numbers enable row level security;

create table if not exists public.account_users (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id uuid,
  email text,
  role text not null default 'owner' check (role in ('owner', 'admin', 'viewer')),
  created_at timestamptz not null default now(),
  unique (account_id, email)
);

alter table public.account_users add column if not exists user_id uuid;
-- Phase 4A multi-account auth: one Supabase Auth user can belong to multiple
-- existing accounts. Rollback, if ever needed, is to first ensure every user_id
-- appears in at most one account_users row, then recreate the old unique
-- account_users_user_id_unique_idx on (user_id).
drop index if exists account_users_user_id_unique_idx;
create index if not exists account_users_user_id_idx
  on public.account_users (user_id)
  where user_id is not null;
create unique index if not exists account_users_account_user_id_unique_idx
  on public.account_users (account_id, user_id)
  where user_id is not null;
create index if not exists account_users_email_idx
  on public.account_users (lower(email))
  where email is not null;

-- Owner-facing audit trail for account changes (who changed texting/settings).
create table if not exists public.account_audit_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  actor_user_id uuid,
  actor_email text,
  action text not null,
  summary text not null,
  created_at timestamptz not null default now()
);
create index if not exists account_audit_events_account_created_at_idx
  on public.account_audit_events (account_id, created_at desc);
alter table public.account_audit_events enable row level security;

-- Phase 7A platform Operations authorization.
-- Operations access is intentionally separate from account_users membership.
-- A house-account owner is still a normal account user; only an explicit row
-- here can access the internal multi-account console.
-- Rollback: remove the seeded/operator rows, then drop the platform audit and
-- operator tables after confirming no Operations routes still depend on them.
create table if not exists public.platform_operators (
  user_id uuid primary key,
  email text,
  role text not null default 'operator' check (role in ('super_admin', 'operator', 'support')),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.platform_operators add column if not exists email text;
alter table public.platform_operators add column if not exists role text not null default 'operator';
alter table public.platform_operators add column if not exists status text not null default 'active';
alter table public.platform_operators add column if not exists created_by uuid;
alter table public.platform_operators add column if not exists created_at timestamptz not null default now();
alter table public.platform_operators add column if not exists updated_at timestamptz not null default now();
alter table public.platform_operators drop constraint if exists platform_operators_role_check;
alter table public.platform_operators
  add constraint platform_operators_role_check check (role in ('super_admin', 'operator', 'support'));
alter table public.platform_operators drop constraint if exists platform_operators_status_check;
alter table public.platform_operators
  add constraint platform_operators_status_check check (status in ('active', 'revoked'));
create unique index if not exists platform_operators_email_unique_idx
  on public.platform_operators (lower(email));

create table if not exists public.platform_operator_invites (
  email text primary key,
  role text not null default 'operator' check (role in ('super_admin', 'operator', 'support')),
  status text not null default 'pending' check (status in ('pending', 'claimed', 'revoked')),
  created_by uuid,
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);
alter table public.platform_operator_invites enable row level security;
alter table public.platform_operators enable row level security;

create table if not exists public.platform_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null,
  actor_email text,
  target_user_id uuid,
  target_account_id uuid references public.accounts(id) on delete set null,
  action text not null,
  summary text not null,
  created_at timestamptz not null default now()
);
create index if not exists platform_audit_events_created_at_idx
  on public.platform_audit_events (created_at desc);
create index if not exists platform_audit_events_target_account_idx
  on public.platform_audit_events (target_account_id, created_at desc)
  where target_account_id is not null;
alter table public.platform_audit_events enable row level security;

-- Bootstrap the intended first platform operator when the Supabase Auth user
-- already exists. This does not grant Operations to other house-account users.
insert into public.platform_operators (user_id, email, role, status)
select id, lower(email), 'super_admin', 'active'
from auth.users
where lower(email) = 'srlowry21@gmail.com'
on conflict (user_id) do update
set email = excluded.email,
    role = 'super_admin',
    status = 'active',
    updated_at = now();

alter table public.account_users enable row level security;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  call_sid text,
  name text,
  phone text not null,
  message text,
  notes text,
  booked_at timestamptz,
  job_value_cents integer check (job_value_cents is null or job_value_cents >= 0),
  reply_priority_override text check (reply_priority_override is null or reply_priority_override in ('fast', 'today', 'normal')),
  priority text check (priority is null or priority in ('fast', 'today', 'normal')),
  priority_reason text,
  source text not null check (source in ('missed_call', 'intake_form')),
  status text not null default 'new' check (status in ('new', 'contacted', 'booked', 'dead')),
  sms_status text check (sms_status in ('pending', 'queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered', 'skipped_disabled', 'skipped_opt_out', 'skipped_recent')),
  sms_error text,
  twilio_message_sid text,
  sms_updated_at timestamptz,
  recording_sid text,
  recording_url text,
  recording_duration integer,
  recording_status text,
  voicemail_transcript text,
  voicemail_summary text,
  voicemail_transcription_status text check (voicemail_transcription_status is null or voicemail_transcription_status in ('pending', 'processing', 'completed', 'failed')),
  voicemail_transcription_error text,
  voicemail_transcribed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.leads add column if not exists account_id uuid references public.accounts(id);
alter table public.leads add column if not exists call_sid text;
alter table public.leads add column if not exists notes text;
alter table public.leads add column if not exists booked_at timestamptz;
alter table public.leads add column if not exists job_value_cents integer;
alter table public.leads add column if not exists reply_priority_override text;
alter table public.leads add column if not exists priority text;
alter table public.leads add column if not exists priority_reason text;
alter table public.leads add column if not exists sms_status text;
alter table public.leads add column if not exists sms_error text;
alter table public.leads add column if not exists twilio_message_sid text;
alter table public.leads add column if not exists sms_updated_at timestamptz;
alter table public.leads add column if not exists recording_sid text;
alter table public.leads add column if not exists recording_url text;
alter table public.leads add column if not exists recording_duration integer;
alter table public.leads add column if not exists recording_status text;
alter table public.leads add column if not exists voicemail_transcript text;
alter table public.leads add column if not exists voicemail_summary text;
alter table public.leads add column if not exists voicemail_transcription_status text;
alter table public.leads add column if not exists voicemail_transcription_error text;
alter table public.leads add column if not exists voicemail_transcribed_at timestamptz;
alter table public.leads add column if not exists deleted_at timestamptz;
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads
  add constraint leads_status_check check (status in ('new', 'contacted', 'booked', 'dead'));
alter table public.leads drop constraint if exists leads_job_value_cents_check;
alter table public.leads
  add constraint leads_job_value_cents_check check (job_value_cents is null or job_value_cents >= 0);
alter table public.leads drop constraint if exists leads_reply_priority_override_check;
alter table public.leads
  add constraint leads_reply_priority_override_check check (
    reply_priority_override is null or reply_priority_override in ('fast', 'today', 'normal')
  );
update public.leads
  set booked_at = coalesce(booked_at, created_at)
  where booked_at is null
    and (status = 'booked' or job_value_cents > 0);
update public.leads
  set status = 'dead'
  where status = 'booked';
alter table public.leads drop constraint if exists leads_sms_status_check;
alter table public.leads
  add constraint leads_sms_status_check check (sms_status in ('pending', 'queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered', 'skipped_disabled', 'skipped_opt_out', 'skipped_recent'));
alter table public.leads drop constraint if exists leads_voicemail_transcription_status_check;
alter table public.leads
  add constraint leads_voicemail_transcription_status_check check (
    voicemail_transcription_status is null
    or voicemail_transcription_status in ('pending', 'processing', 'completed', 'failed')
  );
alter table public.leads alter column account_id set not null;

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_account_created_at_idx on public.leads (account_id, created_at desc);
create index if not exists leads_account_source_created_at_idx
  on public.leads (account_id, source, created_at desc)
  where deleted_at is null;
create index if not exists leads_account_sms_status_created_at_idx
  on public.leads (account_id, sms_status, created_at desc)
  where deleted_at is null and sms_status is not null;
create index if not exists leads_account_priority_created_at_idx
  on public.leads (account_id, priority, created_at desc)
  where deleted_at is null and priority is not null;
create index if not exists leads_account_booked_at_idx
  on public.leads (account_id, booked_at desc)
  where deleted_at is null and booked_at is not null;
create index if not exists leads_phone_created_at_idx on public.leads (phone, created_at desc);
create index if not exists leads_account_phone_created_at_idx on public.leads (account_id, phone, created_at desc);
create unique index if not exists leads_account_call_sid_unique_idx
  on public.leads (account_id, call_sid)
  where account_id is not null and call_sid is not null;
create unique index if not exists leads_account_twilio_message_sid_unique_idx
  on public.leads (account_id, twilio_message_sid)
  where account_id is not null and twilio_message_sid is not null;
-- The global (non-account-scoped) unique indexes are dropped: idempotency is enforced
-- per account. Twilio sids are globally unique within one Twilio account anyway, and the
-- global versions would cause cross-tenant insert failures if a second Twilio account is
-- ever added.
drop index if exists leads_call_sid_unique_idx;
drop index if exists leads_twilio_message_sid_unique_idx;
create index if not exists leads_call_sid_idx on public.leads (call_sid) where call_sid is not null;
create index if not exists leads_deleted_at_idx on public.leads (deleted_at);

alter table public.leads enable row level security;

-- Phase 2 technical setup state. Positive readiness comes only from a real
-- missed-call lead; billing, A2P, activation dates, and health checks are not
-- technical go-live evidence.
update public.accounts
set
  onboarding_status = 'paused',
  onboarding_status_updated_at = coalesce(onboarding_status_updated_at, now())
where onboarding_status = 'paused_incomplete';

update public.accounts
set
  onboarding_status = 'closed',
  onboarding_status_updated_at = coalesce(onboarding_status_updated_at, now())
where onboarding_status = 'closed_incomplete';

update public.accounts as account
set
  onboarding_status = 'live',
  onboarding_status_updated_at = coalesce(
    (
      select min(lead.created_at)
      from public.leads as lead
      where lead.account_id = account.id
        and lead.source = 'missed_call'
        and lead.deleted_at is null
    ),
    account.onboarding_status_updated_at,
    now()
  )
where account.onboarding_status not in ('paused', 'closed')
  and exists (
    select 1
    from public.leads as lead
    where lead.account_id = account.id
      and lead.source = 'missed_call'
      and lead.deleted_at is null
  );

update public.accounts as account
set
  onboarding_status = case
    when settings.call_mode = 'forwarding'
      and exists (
        select 1
        from public.account_phone_numbers as number
        where number.account_id = account.id
      )
      then 'waiting_for_forwarding'
    else 'setting_up'
  end,
  onboarding_status_updated_at = coalesce(account.onboarding_status_updated_at, now())
from public.account_settings as settings
where settings.account_id = account.id
  and account.onboarding_status not in ('live', 'paused', 'closed');

create or replace function public.create_missed_call_lead_and_mark_live(
  p_account_id uuid,
  p_call_sid text,
  p_phone text,
  p_message text,
  p_twilio_signature_valid boolean
)
returns table (
  inserted boolean,
  lead_id uuid,
  lead_created_at timestamptz,
  became_live boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_lead_id uuid;
  v_created_at timestamptz;
  v_became_live boolean := false;
  v_updated_rows integer := 0;
begin
  insert into public.leads (
    account_id,
    call_sid,
    phone,
    message,
    sms_status,
    source,
    status
  )
  values (
    p_account_id,
    p_call_sid,
    p_phone,
    p_message,
    'pending',
    'missed_call',
    'new'
  )
  on conflict (account_id, call_sid)
    where account_id is not null and call_sid is not null
    do nothing
  returning id, created_at into v_lead_id, v_created_at;

  if v_lead_id is null then
    return query select false, null::uuid, null::timestamptz, false;
    return;
  end if;

  if p_twilio_signature_valid then
    update public.accounts
    set
      onboarding_status = 'live',
      onboarding_status_updated_at = v_created_at,
      requirements_due_at = null
    where id = p_account_id
      and onboarding_status in ('setting_up', 'waiting_for_forwarding');

    get diagnostics v_updated_rows = row_count;
    v_became_live := v_updated_rows > 0;

    if v_became_live then
      insert into public.account_audit_events (
        account_id,
        actor_user_id,
        actor_email,
        action,
        summary
      )
      values (
        p_account_id,
        null,
        null,
        'onboarding.first_call_live',
        'A signed, newly inserted real missed call marked call capture live.'
      );
    end if;
  end if;

  return query select true, v_lead_id, v_created_at, v_became_live;
end;
$$;

revoke all on function public.create_missed_call_lead_and_mark_live(
  uuid,
  text,
  text,
  text,
  boolean
) from public, anon, authenticated;

grant execute on function public.create_missed_call_lead_and_mark_live(
  uuid,
  text,
  text,
  text,
  boolean
) to service_role;

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts(id),
  created_at timestamptz not null default now(),
  source text not null check (source in ('twilio_voice', 'twilio_dial_status', 'twilio_inbound_sms', 'twilio_sms_status', 'twilio_recording')),
  payload jsonb not null default '{}'::jsonb,
  response_status integer not null,
  response_body text,
  error text
);

-- webhook_events.account_id intentionally remains nullable.
-- Unresolved Twilio webhooks are logged with sanitized payloads and no tenant writes.
alter table public.webhook_events add column if not exists account_id uuid references public.accounts(id);
alter table public.webhook_events add column if not exists correlation_id text;
alter table public.webhook_events drop constraint if exists webhook_events_source_check;
alter table public.webhook_events
  add constraint webhook_events_source_check check (source in ('twilio_voice', 'twilio_dial_status', 'twilio_inbound_sms', 'twilio_sms_status', 'twilio_recording'));

create index if not exists webhook_events_created_at_idx
  on public.webhook_events (created_at desc);
create index if not exists webhook_events_account_created_at_idx
  on public.webhook_events (account_id, created_at desc);
create index if not exists webhook_events_correlation_id_idx
  on public.webhook_events (correlation_id);

alter table public.webhook_events enable row level security;

create table if not exists public.opt_outs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  phone text not null,
  created_at timestamptz not null default now(),
  unique (account_id, phone)
);

alter table public.opt_outs drop constraint if exists opt_outs_pkey;
alter table public.opt_outs add column if not exists id uuid default gen_random_uuid();
update public.opt_outs set id = gen_random_uuid() where id is null;
alter table public.opt_outs alter column id set not null;
alter table public.opt_outs add constraint opt_outs_pkey primary key (id);
alter table public.opt_outs add column if not exists account_id uuid references public.accounts(id);
alter table public.opt_outs alter column account_id set not null;
alter table public.opt_outs alter column phone set not null;
create unique index if not exists opt_outs_account_phone_unique_idx
  on public.opt_outs (account_id, phone)
  where account_id is not null;

alter table public.opt_outs enable row level security;

create table if not exists public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  message_sid text not null unique,
  from_phone text not null,
  to_phone text,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.inbound_messages add column if not exists account_id uuid references public.accounts(id);
alter table public.inbound_messages alter column account_id set not null;
create unique index if not exists inbound_messages_account_message_sid_unique_idx
  on public.inbound_messages (account_id, message_sid)
  where account_id is not null;
create index if not exists inbound_messages_account_from_created_at_idx
  on public.inbound_messages (account_id, from_phone, created_at desc);
create index if not exists inbound_messages_account_created_at_idx
  on public.inbound_messages (account_id, created_at desc);

alter table public.inbound_messages enable row level security;

create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  call_sid text not null,
  parent_call_sid text,
  from_phone text,
  to_phone text,
  direction text not null default 'inbound',
  status text,
  dial_call_status text,
  lead_id uuid references public.leads(id) on delete set null,
  recording_sid text,
  recording_url text,
  recording_duration integer,
  recording_status text,
  raw_summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, call_sid)
);

create index if not exists calls_account_created_at_idx on public.calls (account_id, created_at desc);
create index if not exists calls_account_from_created_at_idx on public.calls (account_id, from_phone, created_at desc);
create index if not exists calls_call_sid_idx on public.calls (call_sid);

alter table public.calls enable row level security;

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  call_id uuid references public.calls(id) on delete set null,
  twilio_message_sid text,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_phone text,
  to_phone text,
  body text,
  status text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, twilio_message_sid)
);

create index if not exists messages_account_created_at_idx on public.messages (account_id, created_at desc);
create index if not exists messages_account_phone_created_at_idx on public.messages (account_id, from_phone, to_phone, created_at desc);
create index if not exists messages_account_direction_lead_created_at_idx
  on public.messages (account_id, direction, lead_id, created_at desc)
  where lead_id is not null;
create index if not exists messages_twilio_message_sid_idx on public.messages (twilio_message_sid);

alter table public.messages enable row level security;

create table if not exists public.forwarding_health_checks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  phone_number_tested text not null,
  status text not null check (status in ('pending', 'passed', 'failed', 'timeout', 'error')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  outbound_twilio_call_sid text,
  inbound_twilio_call_sid text,
  failure_reason text check (
    failure_reason is null
    or failure_reason in (
      'no_forwarded_call_received',
      'twilio_outbound_failed',
      'webhook_error',
      'rate_limited',
      'unknown_error'
    )
  ),
  raw_event_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.forwarding_health_checks add column if not exists account_id uuid references public.accounts(id);
alter table public.forwarding_health_checks alter column account_id set not null;
create index if not exists forwarding_health_checks_created_at_idx
  on public.forwarding_health_checks (created_at desc);
create index if not exists forwarding_health_checks_account_created_at_idx
  on public.forwarding_health_checks (account_id, created_at desc);
create index if not exists forwarding_health_checks_account_status_completed_at_idx
  on public.forwarding_health_checks (account_id, status, completed_at desc)
  where completed_at is not null;
create index if not exists forwarding_health_checks_pending_started_at_idx
  on public.forwarding_health_checks (started_at desc)
  where status = 'pending';
create index if not exists forwarding_health_checks_account_pending_started_at_idx
  on public.forwarding_health_checks (account_id, started_at desc)
  where status = 'pending';

alter table public.forwarding_health_checks enable row level security;

-- Marketing setup requests from the public intake form. Deliberately separate
-- from leads: leads are customer conversations owned by a tenant account;
-- setup requests are prospects for Relay NW itself and belong to no account.
create table if not exists public.setup_requests (
  id uuid primary key default gen_random_uuid(),
  name text,
  business_name text,
  owner_name text,
  owner_email text,
  phone text not null,
  business_type text,
  public_business_number text,
  message text,
  status text not null default 'new' check (status in ('new', 'contacted', 'onboarded', 'closed')),
  account_id uuid references public.accounts(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists setup_requests_created_at_idx
  on public.setup_requests (created_at desc);

alter table public.setup_requests add column if not exists submitter_hash text;
alter table public.setup_requests add column if not exists business_name text;
alter table public.setup_requests add column if not exists owner_name text;
alter table public.setup_requests add column if not exists owner_email text;
alter table public.setup_requests add column if not exists business_type text;
alter table public.setup_requests add column if not exists public_business_number text;
alter table public.setup_requests add column if not exists account_id uuid references public.accounts(id) on delete set null;

create index if not exists setup_requests_submitter_created_at_idx
  on public.setup_requests (submitter_hash, created_at desc)
  where submitter_hash is not null;

alter table public.setup_requests enable row level security;

-- Service-role-only posture, made explicit. The app talks to these tables solely
-- through the service-role key from server routes. These restrictive deny-all
-- policies for client roles are a tripwire: if someone later adds a permissive
-- policy or flips RLS off in the dashboard, drift is visible right here in SQL.
drop policy if exists deny_client_access on public.accounts;
create policy deny_client_access on public.accounts
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.stripe_events;
create policy deny_client_access on public.stripe_events
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.account_settings;
create policy deny_client_access on public.account_settings
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.account_carrier_profiles;
create policy deny_client_access on public.account_carrier_profiles
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.account_phone_numbers;
create policy deny_client_access on public.account_phone_numbers
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.account_users;
create policy deny_client_access on public.account_users
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.account_audit_events;
create policy deny_client_access on public.account_audit_events
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.leads;
create policy deny_client_access on public.leads
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.webhook_events;
create policy deny_client_access on public.webhook_events
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.opt_outs;
create policy deny_client_access on public.opt_outs
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.inbound_messages;
create policy deny_client_access on public.inbound_messages
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.calls;
create policy deny_client_access on public.calls
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.messages;
create policy deny_client_access on public.messages
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.forwarding_health_checks;
create policy deny_client_access on public.forwarding_health_checks
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.setup_requests;
create policy deny_client_access on public.setup_requests
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.platform_operators;
create policy deny_client_access on public.platform_operators
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.platform_operator_invites;
create policy deny_client_access on public.platform_operator_invites
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.platform_audit_events;
create policy deny_client_access on public.platform_audit_events
  as restrictive for all to anon, authenticated
  using (false) with check (false);

-- Server-side lead inbox search/filter/counts. The inbox UI condenses leads by
-- phone (one card per caller, newest row wins) before filtering, counting, or
-- searching; these functions do the same condensation in SQL so filter-pill
-- counts, the Booked tab, and search see every page for the account, not just
-- whichever page happens to be loaded client-side.
create index if not exists leads_search_trgm_idx on public.leads
  using gin (
    (
      coalesce(name, '') || ' ' || coalesce(phone, '') || ' ' ||
      coalesce(message, '') || ' ' || coalesce(notes, '') || ' ' ||
      coalesce(voicemail_summary, '') || ' ' || coalesce(voicemail_transcript, '')
    ) gin_trgm_ops
  );

-- Mirrors condenseLeadsByPhone in app/leads/_utils.ts, which the inbox applies
-- SEPARATELY to live and trashed rows. A caller who is trashed and then calls
-- again has both a trashed row and a fresh live row for the same phone, and the
-- UI shows that phone in both the inbox and Trash — so we condense per
-- (phone, is-deleted), yielding up to two rows per phone (newest live + newest
-- trashed), not one.
create or replace function public.lead_inbox_condensed(p_account uuid)
returns setof public.leads
language sql
stable
as $$
  select distinct on (phone, (deleted_at is null)) *
  from public.leads
  where account_id = p_account
  order by phone, (deleted_at is null), created_at desc;
$$;

revoke all on function public.lead_inbox_condensed(uuid) from public, anon, authenticated;
grant execute on function public.lead_inbox_condensed(uuid) to service_role;

-- Mirrors countLeads in app/leads/_utils.ts over the live mailbox projection:
-- one current card per caller phone number. Raw sibling call rows can still
-- feed call_count, but they must not inflate current tab/report counts.
create or replace function public.lead_inbox_counts(p_account uuid)
returns table (
  all_count bigint,
  new_count bigint,
  actionable_count bigint,
  contacted_count bigint,
  booked_count bigint,
  dead_count bigint,
  trash_count bigint,
  sms_issues_count bigint,
  booked_value_cents bigint,
  booked_with_value_count bigint
)
language sql
stable
as $$
  with rollup as (
    select * from public.lead_inbox_condensed(p_account)
  )
  select
    (select count(*) from rollup where deleted_at is null) as all_count,
    (select count(*) from rollup where deleted_at is null and status = 'new') as new_count,
    (select count(*) from rollup where deleted_at is null and status in ('new', 'contacted')) as actionable_count,
    (select count(*) from rollup where deleted_at is null and status = 'contacted') as contacted_count,
    (select count(*) from rollup where deleted_at is null and (booked_at is not null or status = 'booked')) as booked_count,
    (select count(*) from rollup where deleted_at is null and status = 'dead') as dead_count,
    (select count(*) from rollup where deleted_at is not null) as trash_count,
    (
      select count(*)
      from rollup
      where deleted_at is null and status = 'new' and sms_status in ('failed', 'undelivered')
    ) as sms_issues_count,
    coalesce((
      select sum(job_value_cents)
      from rollup
      where deleted_at is null and (booked_at is not null or status = 'booked')
    ), 0) as booked_value_cents,
    (
      select count(*)
      from rollup
      where deleted_at is null
        and (booked_at is not null or status = 'booked')
        and job_value_cents is not null
        and job_value_cents > 0
    ) as booked_with_value_count;
$$;

revoke all on function public.lead_inbox_counts(uuid) from public, anon, authenticated;
grant execute on function public.lead_inbox_counts(uuid) to service_role;

-- Mirrors filterLeads + leadMatchesSearch in app/leads/_utils.ts, minus
-- inbound SMS bodies and the derived priority/source labels (not worth a
-- join for an inbox search box). p_query is escaped so a caller searching a
-- literal "%" or "_" isn't surprised by wildcard behavior. call_count is the
-- total number of call rows for the phone across the whole account (every row,
-- including trashed), mirroring countCallsByPhone — this is the "Called N×"
-- badge, and is now accurate across pages rather than only within the loaded
-- page as the old client-only count was.
-- Dropped-then-created (not create-or-replace) because the returned columns
-- changed, which Postgres treats as a return-type change.
drop function if exists public.search_lead_inbox(uuid, text, text, int, int);
create function public.search_lead_inbox(
  p_account uuid,
  p_filter text,
  p_query text,
  p_limit int,
  p_offset int
)
returns table (
  id uuid,
  account_id uuid,
  call_sid text,
  name text,
  phone text,
  message text,
  notes text,
  booked_at timestamptz,
  job_value_cents integer,
  reply_priority_override text,
  priority text,
  priority_reason text,
  source text,
  status text,
  sms_status text,
  sms_error text,
  twilio_message_sid text,
  sms_updated_at timestamptz,
  recording_sid text,
  recording_url text,
  recording_duration integer,
  recording_status text,
  voicemail_transcript text,
  voicemail_summary text,
  voicemail_transcription_status text,
  voicemail_transcription_error text,
  voicemail_transcribed_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz,
  call_count bigint,
  total_count bigint
)
language sql
stable
as $$
  with source_rows as (
    select *
    from public.lead_inbox_condensed(p_account)
  ),
  phone_calls as (
    select phone, count(*) as call_count
    from public.leads
    where account_id = p_account
    group by phone
  ),
  escaped as (
    select replace(
      replace(
        replace(coalesce(p_query, ''), chr(92), chr(92) || chr(92)),
        '%',
        chr(92) || '%'
      ),
      '_',
      chr(92) || '_'
    ) as q
  ),
  filtered as (
    select source_rows.*
    from source_rows, escaped
    where
      (case when coalesce(p_filter, 'all') = 'trash' then deleted_at is not null else deleted_at is null end)
      and (
        coalesce(p_filter, 'all') in ('all', 'trash')
        or (p_filter = 'booked' and (booked_at is not null or status = 'booked'))
        or (p_filter not in ('all', 'trash', 'booked') and status = p_filter)
      )
      and (
        escaped.q = ''
        or (
          coalesce(name, '') || ' ' || coalesce(phone, '') || ' ' ||
          case when nullif(btrim(coalesce(name, '')), '') is null then 'Unknown caller ' else '' end ||
          coalesce(message, '') || ' ' || coalesce(notes, '') || ' ' ||
          coalesce(voicemail_summary, '') || ' ' || coalesce(voicemail_transcript, '')
        ) ilike '%' || escaped.q || '%' escape chr(92)
      )
  )
  select
    f.id, f.account_id, f.call_sid, f.name, f.phone, f.message, f.notes, f.booked_at,
    f.job_value_cents, f.reply_priority_override, f.priority, f.priority_reason, f.source,
    f.status, f.sms_status, f.sms_error, f.twilio_message_sid, f.sms_updated_at, f.recording_sid,
    f.recording_url, f.recording_duration, f.recording_status, f.voicemail_transcript,
    f.voicemail_summary, f.voicemail_transcription_status, f.voicemail_transcription_error,
    f.voicemail_transcribed_at, f.deleted_at, f.created_at,
    coalesce(pc.call_count, 1) as call_count,
    count(*) over () as total_count
  from filtered f
  left join phone_calls pc on pc.phone = f.phone
  order by f.created_at desc, f.id desc
  limit p_limit offset p_offset;
$$;

revoke all on function public.search_lead_inbox(uuid, text, text, int, int) from public, anon, authenticated;
grant execute on function public.search_lead_inbox(uuid, text, text, int, int) to service_role;
