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
  free_access_review_at timestamptz,
  commercial_offer text not null default 'standard' check (
    commercial_offer in ('standard', 'founding_pilot')
  ),
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_price_id text,
  stripe_subscription_status text,
  billing_setup_checkout_session_id text,
  stripe_setup_intent_id text,
  stripe_setup_intent_status text,
  stripe_default_payment_method_id text,
  payment_method_updated_at timestamptz,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  onboarding_status text not null default 'setting_up' check (
    onboarding_status in (
      'setting_up',
      'waiting_for_forwarding',
      'live',
      'paused',
      'closed'
    )
  ),
  onboarding_status_updated_at timestamptz,
  ops_blocked_by text not null default 'none' check (
    ops_blocked_by in ('none', 'relay', 'customer', 'carrier')
  ),
  ops_blocker_note text,
  ops_blocked_since timestamptz,
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
alter table public.accounts add column if not exists free_access_review_at timestamptz;
alter table public.accounts add column if not exists commercial_offer text not null default 'standard';
alter table public.accounts add column if not exists stripe_customer_id text;
alter table public.accounts add column if not exists stripe_subscription_id text;
alter table public.accounts add column if not exists stripe_price_id text;
alter table public.accounts add column if not exists stripe_subscription_status text;
alter table public.accounts add column if not exists billing_setup_checkout_session_id text;
alter table public.accounts add column if not exists stripe_setup_intent_id text;
alter table public.accounts add column if not exists stripe_setup_intent_status text;
alter table public.accounts add column if not exists stripe_default_payment_method_id text;
alter table public.accounts add column if not exists payment_method_updated_at timestamptz;
alter table public.accounts add column if not exists trial_ends_at timestamptz;
alter table public.accounts add column if not exists current_period_end timestamptz;
alter table public.accounts add column if not exists cancel_at_period_end boolean not null default false;
alter table public.accounts add column if not exists onboarding_status text not null default 'setting_up';
alter table public.accounts alter column onboarding_status set default 'setting_up';
alter table public.accounts add column if not exists onboarding_status_updated_at timestamptz;
alter table public.accounts add column if not exists ops_blocked_by text not null default 'none';
alter table public.accounts add column if not exists ops_blocker_note text;
alter table public.accounts add column if not exists ops_blocked_since timestamptz;
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
alter table public.accounts drop column if exists requirements_due_at;
alter table public.accounts drop column if exists stripe_payment_method_id;
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
update public.accounts
set free_access_review_at = null
where billing_policy <> 'comped'
  and free_access_review_at is not null;
do $$
begin
  alter table public.accounts
    add constraint accounts_free_access_review_requires_comp_check
    check (free_access_review_at is null or billing_policy = 'comped');
exception
  when duplicate_object then null;
end $$;
do $$
begin
  alter table public.accounts drop constraint if exists accounts_commercial_offer_check;
  alter table public.accounts
    add constraint accounts_commercial_offer_check
    check (commercial_offer in ('standard', 'founding_pilot'));
exception
  when duplicate_object then null;
end $$;
do $$
begin
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
  end;
  alter table public.accounts drop constraint if exists accounts_onboarding_status_check;
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
exception
  when duplicate_object then null;
end $$;
update public.accounts
set
  ops_blocked_by = 'none',
  ops_blocker_note = null,
  ops_blocked_since = null
where ops_blocked_by is null
   or ops_blocked_by not in ('none', 'relay', 'customer', 'carrier')
   or (
     ops_blocked_by = 'none'
     and (ops_blocker_note is not null or ops_blocked_since is not null)
   )
   or (
     ops_blocked_by <> 'none'
     and (
       ops_blocker_note is null
       or length(trim(ops_blocker_note)) < 5
       or length(trim(ops_blocker_note)) > 240
       or ops_blocked_since is null
     )
   );
alter table public.accounts alter column ops_blocked_by set default 'none';
alter table public.accounts alter column ops_blocked_by set not null;
alter table public.accounts drop constraint if exists accounts_ops_blocked_by_check;
alter table public.accounts
  add constraint accounts_ops_blocked_by_check
  check (ops_blocked_by in ('none', 'relay', 'customer', 'carrier'));
alter table public.accounts drop constraint if exists accounts_ops_blocker_consistency_check;
alter table public.accounts
  add constraint accounts_ops_blocker_consistency_check
  check (
    (
      ops_blocked_by = 'none'
      and ops_blocker_note is null
      and ops_blocked_since is null
    )
    or
    (
      ops_blocked_by in ('relay', 'customer', 'carrier')
      and ops_blocker_note is not null
      and length(trim(ops_blocker_note)) between 5 and 240
      and ops_blocked_since is not null
    )
  );
do $$
begin
  alter table public.accounts drop constraint if exists accounts_stripe_setup_intent_status_check;
  alter table public.accounts
    add constraint accounts_stripe_setup_intent_status_check
    check (
      stripe_setup_intent_status is null or
      stripe_setup_intent_status in (
        'requires_payment_method',
        'requires_confirmation',
        'requires_action',
        'processing',
        'canceled',
        'succeeded'
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
create unique index if not exists accounts_billing_setup_checkout_session_unique_idx
  on public.accounts (billing_setup_checkout_session_id)
  where billing_setup_checkout_session_id is not null;
create unique index if not exists accounts_stripe_setup_intent_unique_idx
  on public.accounts (stripe_setup_intent_id)
  where stripe_setup_intent_id is not null;

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

update public.accounts
set commercial_offer = 'founding_pilot'
where billing_policy = 'setup_fee_waived'
  and setup_fee_status = 'waived'
  and commercial_offer = 'standard';

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
  twilio_brand_sid text,
  twilio_campaign_sid text,
  messaging_service_sid text,
  status_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
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

-- Relay-owned billing exceptions are policy, not fake Stripe state. Change
-- the policy and create its required audit event atomically.
create or replace function public.set_account_billing_policy(
  p_account_id uuid,
  p_policy text,
  p_reason text,
  p_actor_user_id uuid,
  p_actor_email text
)
returns table (
  previous_policy text,
  current_policy text
)
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_previous_policy text;
  v_stripe_status text;
  v_setup_fee_status text;
  v_reason text := trim(coalesce(p_reason, ''));
begin
  if p_policy not in ('standard', 'setup_fee_waived', 'comped') then
    raise exception 'Unsupported billing policy';
  end if;

  if length(v_reason) < 5 then
    raise exception 'A meaningful billing-policy reason is required';
  end if;

  select
    billing_policy,
    stripe_subscription_status,
    setup_fee_status
  into
    v_previous_policy,
    v_stripe_status,
    v_setup_fee_status
  from public.accounts
  where id = p_account_id
  for update;

  if not found then
    raise exception 'Account not found';
  end if;

  if p_policy = 'comped'
    and v_stripe_status in (
      'incomplete',
      'trialing',
      'active',
      'past_due',
      'unpaid',
      'paused'
    )
  then
    raise exception 'Cancel or finish the Stripe subscription before comping';
  end if;

  if p_policy = 'setup_fee_waived'
    and v_setup_fee_status in ('paid', 'partially_refunded')
  then
    raise exception 'A paid setup fee cannot be reclassified as waived';
  end if;

  update public.accounts
  set
    billing_policy = p_policy,
    billing_policy_updated_at = now(),
    free_access_review_at = case
      when p_policy = 'comped' then free_access_review_at
      else null
    end
  where id = p_account_id;

  insert into public.account_audit_events (
    account_id,
    actor_user_id,
    actor_email,
    action,
    summary
  )
  values (
    p_account_id,
    p_actor_user_id,
    nullif(trim(coalesce(p_actor_email, '')), ''),
    'billing.policy.' || p_policy,
    v_reason
  );

  return query select v_previous_policy, p_policy;
end;
$function$;

revoke all
on function public.set_account_billing_policy(
  uuid,
  text,
  text,
  uuid,
  text
)
from public, anon, authenticated;

grant execute
on function public.set_account_billing_policy(
  uuid,
  text,
  text,
  uuid,
  text
)
to service_role;

-- Free access is a Relay-owned policy, not a Stripe trial. The optional review
-- date creates an Operations reminder only; it never charges or stops service.
create or replace function public.set_account_free_access(
  p_account_id uuid,
  p_review_at timestamptz,
  p_reason text,
  p_actor_user_id uuid,
  p_actor_email text
)
returns table (
  previous_policy text,
  current_policy text,
  previous_review_at timestamptz,
  current_review_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_previous_policy text;
  v_previous_review_at timestamptz;
  v_stripe_status text;
  v_reason text := trim(coalesce(p_reason, ''));
  v_action text;
  v_review_summary text;
begin
  if length(v_reason) < 5 then
    raise exception 'A meaningful free-access reason is required';
  end if;

  if p_review_at is not null and p_review_at <= now() then
    raise exception 'The free-access review date must be in the future';
  end if;

  select
    billing_policy,
    free_access_review_at,
    stripe_subscription_status
  into
    v_previous_policy,
    v_previous_review_at,
    v_stripe_status
  from public.accounts
  where id = p_account_id
  for update;

  if not found then
    raise exception 'Account not found';
  end if;

  if v_stripe_status in (
    'incomplete',
    'trialing',
    'active',
    'past_due',
    'unpaid',
    'paused'
  ) then
    raise exception 'Cancel or finish the Stripe subscription before granting free access';
  end if;

  v_action := case
    when v_previous_policy = 'comped' then 'billing.free_access.updated'
    else 'billing.free_access.started'
  end;
  v_review_summary := case
    when p_review_at is null then 'No review date scheduled'
    else 'Review on ' || to_char(p_review_at at time zone 'UTC', 'YYYY-MM-DD')
  end;

  update public.accounts
  set
    billing_policy = 'comped',
    billing_policy_updated_at = case
      when billing_policy = 'comped' then billing_policy_updated_at
      else now()
    end,
    free_access_review_at = p_review_at
  where id = p_account_id;

  insert into public.account_audit_events (
    account_id,
    actor_user_id,
    actor_email,
    action,
    summary
  )
  values (
    p_account_id,
    p_actor_user_id,
    nullif(trim(coalesce(p_actor_email, '')), ''),
    v_action,
    v_review_summary || ' — ' || v_reason
  );

  return query
  select
    v_previous_policy,
    'comped'::text,
    v_previous_review_at,
    p_review_at;
end;
$function$;

revoke all
on function public.set_account_free_access(
  uuid,
  timestamptz,
  text,
  uuid,
  text
)
from public, anon, authenticated;

grant execute
on function public.set_account_free_access(
  uuid,
  timestamptz,
  text,
  uuid,
  text
)
to service_role;

create or replace function public.set_account_commercial_offer(
  p_account_id uuid,
  p_offer text,
  p_reason text,
  p_actor_user_id uuid,
  p_actor_email text
)
returns table (
  previous_offer text,
  current_offer text
)
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_previous_offer text;
  v_billing_policy text;
  v_subscription_status text;
  v_setup_fee_status text;
begin
  if p_offer not in ('standard', 'founding_pilot') then
    raise exception 'Unsupported commercial offer';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then
    raise exception 'A meaningful commercial-offer reason is required';
  end if;

  select
    commercial_offer,
    billing_policy,
    stripe_subscription_status,
    setup_fee_status
  into
    v_previous_offer,
    v_billing_policy,
    v_subscription_status,
    v_setup_fee_status
  from public.accounts
  where id = p_account_id
  for update;

  if not found then
    raise exception 'Account not found';
  end if;
  if v_subscription_status in (
    'incomplete',
    'trialing',
    'active',
    'past_due',
    'unpaid',
    'paused'
  ) then
    raise exception 'Cannot change the commercial offer while Stripe has a nonterminal subscription';
  end if;
  if p_offer = 'founding_pilot'
    and v_setup_fee_status not in ('due', 'waived')
  then
    raise exception 'Cannot turn a Stripe payment, refund, or dispute into a pilot waiver';
  end if;

  update public.accounts
  set
    commercial_offer = p_offer,
    billing_policy = case
      when v_billing_policy = 'comped' then 'comped'
      when p_offer = 'founding_pilot' then 'setup_fee_waived'
      else 'standard'
    end,
    billing_policy_updated_at = now(),
    setup_fee_status = case
      when p_offer = 'founding_pilot' then 'waived'
      when setup_fee_status = 'waived' then 'due'
      else setup_fee_status
    end,
    setup_fee_waived_at = case
      when p_offer = 'founding_pilot' then coalesce(setup_fee_waived_at, now())
      when setup_fee_status = 'waived' then null
      else setup_fee_waived_at
    end,
    setup_fee_waiver_reason = case
      when p_offer = 'founding_pilot' then trim(p_reason)
      when setup_fee_status = 'waived' then null
      else setup_fee_waiver_reason
    end
  where id = p_account_id;

  insert into public.account_audit_events (
    account_id,
    actor_user_id,
    actor_email,
    action,
    summary
  )
  values (
    p_account_id,
    p_actor_user_id,
    p_actor_email,
    case
      when p_offer = 'founding_pilot' then 'billing.offer.founding_pilot'
      else 'billing.offer.standard'
    end,
    case
      when p_offer = 'founding_pilot'
        then 'Applied founding-pilot terms: audited $150 waiver and 30-day delayed Stripe trial — ' || trim(p_reason)
      else 'Applied standard terms: $150 setup fee and 14-day delayed Stripe trial — ' || trim(p_reason)
    end
  );

  return query select v_previous_offer, p_offer;
end;
$function$;

revoke all
on function public.set_account_commercial_offer(
  uuid,
  text,
  text,
  uuid,
  text
)
from public, anon, authenticated;

grant execute
on function public.set_account_commercial_offer(
  uuid,
  text,
  text,
  uuid,
  text
)
to service_role;

-- Operations stores blocker ownership as an independent audited fact. Queue
-- placement and next action remain derived in application code.
create or replace function public.set_account_ops_blocker(
  p_account_id uuid,
  p_blocked_by text,
  p_note text,
  p_actor_user_id uuid,
  p_actor_email text
)
returns table (
  previous_blocked_by text,
  current_blocked_by text,
  blocked_since timestamptz
)
language plpgsql
security invoker
set search_path = public
as $function$
declare
  v_previous_blocked_by text;
  v_previous_note text;
  v_previous_blocked_since timestamptz;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_next_blocked_since timestamptz;
begin
  if p_blocked_by is null
    or p_blocked_by not in ('none', 'relay', 'customer', 'carrier')
  then
    raise exception 'Unsupported operations blocker owner';
  end if;

  if p_blocked_by <> 'none'
    and (v_note is null or length(v_note) < 5 or length(v_note) > 240)
  then
    raise exception 'A blocker reason between 5 and 240 characters is required';
  end if;

  select
    ops_blocked_by,
    ops_blocker_note,
    ops_blocked_since
  into
    v_previous_blocked_by,
    v_previous_note,
    v_previous_blocked_since
  from public.accounts
  where id = p_account_id
  for update;

  if not found then
    raise exception 'Account not found';
  end if;

  v_next_blocked_since := case
    when p_blocked_by = 'none' then null
    when v_previous_blocked_by = p_blocked_by
      and v_previous_blocked_since is not null
      then v_previous_blocked_since
    else now()
  end;

  update public.accounts
  set
    ops_blocked_by = p_blocked_by,
    ops_blocker_note = case when p_blocked_by = 'none' then null else v_note end,
    ops_blocked_since = v_next_blocked_since
  where id = p_account_id;

  insert into public.account_audit_events (
    account_id,
    actor_user_id,
    actor_email,
    action,
    summary
  )
  values (
    p_account_id,
    p_actor_user_id,
    nullif(trim(coalesce(p_actor_email, '')), ''),
    case
      when p_blocked_by = 'none' then 'ops.blocker.cleared'
      else 'ops.blocker.' || p_blocked_by
    end,
    case
      when p_blocked_by = 'none'
        then case
          when v_previous_blocked_by = 'none'
            then 'Confirmed no operations blocker'
          else 'Cleared ' || v_previous_blocked_by || ' blocker — ' ||
            coalesce(v_previous_note, 'no prior note')
        end
      else 'Blocked by ' || p_blocked_by || ' — ' || v_note
    end
  );

  return query
  select
    v_previous_blocked_by,
    p_blocked_by,
    v_next_blocked_since;
end;
$function$;

revoke all
on function public.set_account_ops_blocker(
  uuid,
  text,
  text,
  uuid,
  text
)
from public, anon, authenticated;

grant execute
on function public.set_account_ops_blocker(
  uuid,
  text,
  text,
  uuid,
  text
)
to service_role;

-- Narrow, audited repair for the reused sample account's known test-mode
-- Stripe contamination. Historical stripe_events remain untouched.
do $repair$
declare
  v_account_id uuid;
begin
  select a.id
  into v_account_id
  from public.accounts a
  where a.slug = 'cascade-plumbing-sample'
    and (
      a.stripe_subscription_id = 'sub_1TwFR5JvfzsHNkkMWA7KT6FM' or
      a.setup_fee_payment_intent_id = 'pi_3TujX0JvfzsHNkkM1ukFdPew'
    )
    and not exists (
      select 1
      from public.stripe_events e
      where e.account_id = a.id
        and e.livemode = true
    )
  for update;

  if v_account_id is not null then
    update public.accounts
    set
      commercial_offer = 'founding_pilot',
      billing_policy = 'setup_fee_waived',
      billing_policy_updated_at = now(),
      billing_status = 'not_started',
      stripe_customer_id = null,
      stripe_subscription_id = null,
      stripe_price_id = null,
      stripe_subscription_status = null,
      billing_setup_checkout_session_id = null,
      stripe_setup_intent_id = null,
      stripe_setup_intent_status = null,
      stripe_default_payment_method_id = null,
      payment_method_updated_at = null,
      trial_ends_at = null,
      current_period_end = null,
      cancel_at_period_end = false,
      activated_at = null,
      first_paid_at = null,
      guarantee_ends_at = null,
      billing_attention_since = null,
      canceled_at = null,
      setup_fee_status = 'waived',
      setup_fee_checkout_session_id = null,
      setup_fee_payment_intent_id = null,
      setup_fee_paid_at = null,
      setup_fee_waived_at = now(),
      setup_fee_waiver_reason = 'Founding-pilot reset after documented Stripe test-mode contamination.',
      setup_fee_refunded_at = null,
      setup_fee_refunded_cents = 0,
      setup_fee_dispute_status = null,
      billing_updated_at = now()
    where id = v_account_id;

    insert into public.account_audit_events (
      account_id,
      actor_user_id,
      actor_email,
      action,
      summary
    )
    values (
      v_account_id,
      null,
      'system:phase1-migration',
      'billing.test_state.reset',
      'Cleared the known test-mode Stripe links and applied founding-pilot terms. Historical Stripe events were preserved.'
    );
  end if;
end
$repair$;

-- Narrow, audited repair for Cascade Plumbing's unsupported A2P approval.
-- Preserve its assigned number and verified call readiness.
do $a2p_truth_repair$
declare
  v_account_id uuid;
  v_repaired boolean := false;
begin
  select a.id
  into v_account_id
  from public.accounts a
  join public.account_phone_numbers p
    on p.account_id = a.id
   and p.phone_number = '+14253683980'
  join public.account_settings s
    on s.account_id = a.id
  join public.account_carrier_profiles c
    on c.account_id = a.id
  where a.slug = 'cascade-plumbing-sample'
    and s.sms_enabled = false
    and s.a2p_registration_status = 'approved'
    and c.status = 'approved'
    and c.twilio_campaign_sid is null
  for update of a, s, c;

  if v_account_id is not null then
    update public.account_settings
    set
      a2p_registration_status = 'not_started',
      updated_at = now()
    where account_id = v_account_id;

    update public.account_carrier_profiles
    set
      status = 'draft',
      twilio_brand_sid = null,
      twilio_campaign_sid = null,
      messaging_service_sid = null,
      status_detail = 'Reset because no Twilio campaign or number-registration evidence supported the prior approval.',
      updated_at = now()
    where account_id = v_account_id;

    v_repaired := true;
  end if;

  if v_repaired then
    insert into public.account_audit_events (
      account_id,
      actor_user_id,
      actor_email,
      action,
      summary
    )
    values (
      v_account_id,
      null,
      'system:a2p-truth-repair',
      'carrier.false_approval_repaired',
      'Reset unsupported A2P approval to not started; no campaign SID or number-registration evidence existed.'
    );
  end if;
end
$a2p_truth_repair$;

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
  voicemail_raw_transcript text,
  voicemail_transcription_model text,
  voicemail_transcription_confidence double precision,
  voicemail_transcription_quality text,
  voicemail_transcription_quality_reasons text[],
  voicemail_transcription_metrics jsonb,
  voicemail_transcript text,
  voicemail_summary text,
  voicemail_summary_classification text,
  voicemail_summary_evidence text[],
  voicemail_summary_validation_reasons text[],
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
alter table public.leads add column if not exists voicemail_raw_transcript text;
alter table public.leads add column if not exists voicemail_transcription_model text;
alter table public.leads add column if not exists voicemail_transcription_confidence double precision;
alter table public.leads add column if not exists voicemail_transcription_quality text;
alter table public.leads add column if not exists voicemail_transcription_quality_reasons text[];
alter table public.leads add column if not exists voicemail_transcription_metrics jsonb;
alter table public.leads add column if not exists voicemail_transcript text;
alter table public.leads add column if not exists voicemail_summary text;
alter table public.leads add column if not exists voicemail_summary_classification text;
alter table public.leads add column if not exists voicemail_summary_evidence text[];
alter table public.leads add column if not exists voicemail_summary_validation_reasons text[];
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
alter table public.leads drop constraint if exists leads_voicemail_transcription_confidence_check;
alter table public.leads
  add constraint leads_voicemail_transcription_confidence_check check (
    voicemail_transcription_confidence is null
    or (
      voicemail_transcription_confidence >= 0
      and voicemail_transcription_confidence <= 1
    )
  );
alter table public.leads drop constraint if exists leads_voicemail_transcription_quality_check;
alter table public.leads
  add constraint leads_voicemail_transcription_quality_check check (
    voicemail_transcription_quality is null
    or voicemail_transcription_quality in ('reliable', 'review_recommended', 'unavailable')
  );
alter table public.leads alter column account_id set not null;

comment on column public.leads.voicemail_raw_transcript is
  'Original text returned by the speech-to-text provider before trimming, formatting, summarization, or other downstream processing.';
comment on column public.leads.voicemail_transcription_confidence is
  'Geometric-mean token confidence derived from provider log probabilities, in the range 0 to 1.';
comment on column public.leads.voicemail_transcription_quality is
  'Fail-closed quality decision. Only reliable transcripts may be shown or summarized.';
comment on column public.leads.voicemail_transcription_metrics is
  'Aggregate confidence metrics only; token-level text/logprobs are not duplicated here.';
comment on column public.leads.voicemail_summary_evidence is
  'Exact transcript excerpts supplied as evidence for the generated summary.';

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
      onboarding_status_updated_at = v_created_at
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

drop table if exists public.forwarding_health_checks;

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

-- Durable authentication abuse controls. Identifiers are server-side HMACs,
-- never raw email addresses or IPs.
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

  delete from public.auth_rate_limit_events
  where created_at < now() - interval '7 days';

  return true;
end;
$$;

revoke all on function public.consume_auth_rate_limit(text, text, text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_auth_rate_limit(text, text, text, integer, integer, integer)
  to service_role;

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

-- Phase 2 multi-business isolation hardening. The standalone production
-- migration performs explicit legacy-data preflights before applying these
-- constraints: docs/migrations/2026-07-29-tenant-isolation-hardening.sql.
alter table public.account_settings alter column account_id set not null;
alter table public.account_carrier_profiles alter column account_id set not null;
alter table public.account_phone_numbers alter column account_id set not null;
alter table public.account_users alter column account_id set not null;
alter table public.account_audit_events alter column account_id set not null;
alter table public.leads alter column account_id set not null;
alter table public.opt_outs alter column account_id set not null;
alter table public.inbound_messages alter column account_id set not null;
alter table public.calls alter column account_id set not null;
alter table public.messages alter column account_id set not null;

do $$
begin
  alter table public.account_phone_numbers
    add constraint account_phone_numbers_e164_check
    check (phone_number ~ '^\+[1-9][0-9]{7,14}$') not valid;
exception
  when duplicate_object then null;
end
$$;
alter table public.account_phone_numbers
  validate constraint account_phone_numbers_e164_check;

create unique index if not exists account_phone_numbers_phone_unique_idx
  on public.account_phone_numbers (phone_number);
create unique index if not exists account_phone_numbers_one_primary_per_account_idx
  on public.account_phone_numbers (account_id)
  where is_primary;
create unique index if not exists account_phone_numbers_account_twilio_sid_unique_idx
  on public.account_phone_numbers (account_id, twilio_sid)
  where twilio_sid is not null;
create unique index if not exists leads_account_recording_sid_unique_idx
  on public.leads (account_id, recording_sid)
  where recording_sid is not null;
create unique index if not exists calls_account_recording_sid_unique_idx
  on public.calls (account_id, recording_sid)
  where recording_sid is not null;

create unique index if not exists leads_account_id_id_unique_idx
  on public.leads (account_id, id);
create unique index if not exists calls_account_id_id_unique_idx
  on public.calls (account_id, id);

do $$
begin
  alter table public.calls
    add constraint calls_account_lead_tenant_fk
    foreign key (account_id, lead_id)
    references public.leads (account_id, id)
    on delete set null (lead_id)
    not valid;
exception
  when duplicate_object then null;
end
$$;
do $$
begin
  alter table public.messages
    add constraint messages_account_lead_tenant_fk
    foreign key (account_id, lead_id)
    references public.leads (account_id, id)
    on delete set null (lead_id)
    not valid;
exception
  when duplicate_object then null;
end
$$;
do $$
begin
  alter table public.messages
    add constraint messages_account_call_tenant_fk
    foreign key (account_id, call_id)
    references public.calls (account_id, id)
    on delete set null (call_id)
    not valid;
exception
  when duplicate_object then null;
end
$$;
alter table public.calls
  validate constraint calls_account_lead_tenant_fk;
alter table public.messages
  validate constraint messages_account_lead_tenant_fk;
alter table public.messages
  validate constraint messages_account_call_tenant_fk;

create or replace function public.assign_primary_account_phone_number(
  p_account_id uuid,
  p_phone_number text,
  p_twilio_sid text,
  p_label text
)
returns table (
  number_changed boolean,
  previous_phone_number text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account_status text;
  v_existing_account_id uuid;
  v_existing_number_found boolean := false;
  v_previous_phone_number text;
  v_call_mode text;
  v_written_rows integer := 0;
begin
  if p_account_id is null then
    raise exception 'Missing account id';
  end if;
  if p_phone_number is null
     or p_phone_number !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception 'Relay number must use E.164 format';
  end if;
  if nullif(trim(p_twilio_sid), '') is null then
    raise exception 'Missing Twilio phone-number SID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('relay-number:' || p_phone_number, 0)
  );

  select account.status
  into v_account_status
  from public.accounts as account
  where account.id = p_account_id
  for update;
  if not found then
    raise exception 'Target account does not exist';
  end if;
  if v_account_status = 'archived' then
    raise exception 'Cannot assign a Relay number to an archived account';
  end if;

  select number.account_id
  into v_existing_account_id
  from public.account_phone_numbers as number
  where number.phone_number = p_phone_number
  for update;
  v_existing_number_found := found;
  if v_existing_number_found
     and v_existing_account_id <> p_account_id then
    raise exception using
      errcode = '23505',
      message = 'Relay number is already assigned to another account';
  end if;

  select number.phone_number
  into v_previous_phone_number
  from public.account_phone_numbers as number
  where number.account_id = p_account_id
  order by number.is_primary desc, number.created_at asc
  limit 1
  for update;

  update public.account_phone_numbers
  set is_primary = false, updated_at = now()
  where account_id = p_account_id
    and is_primary;

  insert into public.account_phone_numbers (
    account_id,
    phone_number,
    label,
    is_primary,
    twilio_sid,
    updated_at
  )
  values (
    p_account_id,
    p_phone_number,
    coalesce(nullif(trim(p_label), ''), 'Primary Relay number'),
    true,
    trim(p_twilio_sid),
    now()
  )
  on conflict (phone_number) do update
  set
    label = excluded.label,
    is_primary = true,
    twilio_sid = excluded.twilio_sid,
    updated_at = excluded.updated_at
  where public.account_phone_numbers.account_id = p_account_id;

  get diagnostics v_written_rows = row_count;
  if v_written_rows <> 1 then
    raise exception 'Relay number assignment did not write exactly one owned row';
  end if;

  number_changed :=
    coalesce(v_previous_phone_number, '') <> p_phone_number;
  previous_phone_number := v_previous_phone_number;

  if number_changed then
    select settings.call_mode
    into v_call_mode
    from public.account_settings as settings
    where settings.account_id = p_account_id;

    update public.accounts
    set
      onboarding_status = case
        when v_call_mode = 'forwarding'
          then 'waiting_for_forwarding'
        else 'setting_up'
      end,
      onboarding_status_updated_at = now(),
      updated_at = now()
    where id = p_account_id
      and onboarding_status not in ('paused', 'closed');
  end if;

  return next;
end
$$;
revoke all on function public.assign_primary_account_phone_number(
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;
grant execute on function public.assign_primary_account_phone_number(
  uuid,
  text,
  text,
  text
) to service_role;

create or replace function public.release_closed_account_phone_numbers(
  p_account_id uuid
)
returns table (phone_number text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_account_status text;
  v_onboarding_status text;
begin
  if p_account_id is null then
    raise exception 'Missing account id';
  end if;

  select account.status, account.onboarding_status
  into v_account_status, v_onboarding_status
  from public.accounts as account
  where account.id = p_account_id
  for update;
  if not found then
    raise exception 'Target account does not exist';
  end if;
  if v_account_status <> 'archived'
     or v_onboarding_status <> 'closed' then
    raise exception 'Relay numbers can only be released from a closed archived account';
  end if;

  return query
    delete from public.account_phone_numbers as number
    where number.account_id = p_account_id
    returning number.phone_number;
end
$$;
revoke all on function public.release_closed_account_phone_numbers(uuid)
  from public, anon, authenticated;
grant execute on function public.release_closed_account_phone_numbers(uuid)
  to service_role;
