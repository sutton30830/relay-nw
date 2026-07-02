create extension if not exists pgcrypto;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.accounts enable row level security;

create table if not exists public.account_settings (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  business_name text not null,
  owner_email text,
  owner_phone_number text not null,
  intake_url text not null,
  scheduling_url text,
  call_mode text not null default 'forwarding' check (call_mode in ('direct', 'forwarding')),
  sms_enabled boolean not null default false,
  sms_template text,
  missed_call_voice_message text,
  missed_call_voice_name text not null default 'Polly.Joanna-Neural',
  missed_call_greeting_audio_url text,
  voicemail_max_seconds integer not null default 60 check (voicemail_max_seconds > 0),
  dial_timeout_seconds integer not null default 18 check (dial_timeout_seconds > 0),
  missed_call_sms_cooldown_hours integer not null default 24 check (missed_call_sms_cooldown_hours > 0),
  voicemail_transcription_enabled boolean not null default true,
  a2p_registration_status text not null default 'not_started' check (
    a2p_registration_status in ('not_started', 'in_progress', 'approved', 'rejected', 'paused')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.account_settings add column if not exists owner_email text;

alter table public.account_settings enable row level security;

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
create unique index if not exists account_users_user_id_unique_idx
  on public.account_users (user_id)
  where user_id is not null;
create index if not exists account_users_email_idx
  on public.account_users (lower(email))
  where email is not null;

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
create index if not exists forwarding_health_checks_pending_started_at_idx
  on public.forwarding_health_checks (started_at desc)
  where status = 'pending';

alter table public.forwarding_health_checks enable row level security;

-- Marketing setup requests from the public intake form. Deliberately separate
-- from leads: leads are customer conversations owned by a tenant account;
-- setup requests are prospects for Relay NW itself and belong to no account.
create table if not exists public.setup_requests (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone text not null,
  message text,
  status text not null default 'new' check (status in ('new', 'contacted', 'onboarded', 'closed')),
  created_at timestamptz not null default now()
);

create index if not exists setup_requests_created_at_idx
  on public.setup_requests (created_at desc);

alter table public.setup_requests enable row level security;

-- This MVP uses the Supabase service role key from server-only Next.js routes.
-- No browser/client table access is needed, so no public RLS policies are added.
