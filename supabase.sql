create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  call_sid text,
  name text,
  phone text not null,
  message text,
  notes text,
  source text not null check (source in ('missed_call', 'intake_form')),
  status text not null default 'new' check (status in ('new', 'contacted', 'booked', 'dead')),
  sms_status text check (sms_status in ('pending', 'sent', 'failed', 'skipped_opt_out', 'skipped_recent')),
  sms_error text,
  twilio_message_sid text,
  sms_updated_at timestamptz,
  recording_sid text,
  recording_url text,
  recording_duration integer,
  recording_status text,
  created_at timestamptz not null default now()
);

alter table public.leads add column if not exists call_sid text;
alter table public.leads add column if not exists notes text;
alter table public.leads add column if not exists sms_status text;
alter table public.leads add column if not exists sms_error text;
alter table public.leads add column if not exists twilio_message_sid text;
alter table public.leads add column if not exists sms_updated_at timestamptz;
alter table public.leads add column if not exists recording_sid text;
alter table public.leads add column if not exists recording_url text;
alter table public.leads add column if not exists recording_duration integer;
alter table public.leads add column if not exists recording_status text;
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads
  add constraint leads_status_check check (status in ('new', 'contacted', 'booked', 'dead'));
alter table public.leads drop constraint if exists leads_sms_status_check;
alter table public.leads
  add constraint leads_sms_status_check check (sms_status in ('pending', 'queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered', 'skipped_opt_out', 'skipped_recent'));

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create index if not exists leads_phone_created_at_idx on public.leads (phone, created_at desc);
create unique index if not exists leads_call_sid_unique_idx
  on public.leads (call_sid)
  where call_sid is not null;
create unique index if not exists leads_twilio_message_sid_unique_idx
  on public.leads (twilio_message_sid)
  where twilio_message_sid is not null;

alter table public.leads enable row level security;

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null check (source in ('twilio_voice', 'twilio_dial_status', 'twilio_inbound_sms', 'twilio_sms_status', 'twilio_recording')),
  payload jsonb not null default '{}'::jsonb,
  response_status integer not null,
  response_body text,
  error text
);

alter table public.webhook_events drop constraint if exists webhook_events_source_check;
alter table public.webhook_events
  add constraint webhook_events_source_check check (source in ('twilio_voice', 'twilio_dial_status', 'twilio_inbound_sms', 'twilio_sms_status', 'twilio_recording'));

alter table public.webhook_events enable row level security;

create table if not exists public.opt_outs (
  phone text primary key,
  created_at timestamptz not null default now()
);

alter table public.opt_outs enable row level security;

create table if not exists public.inbound_messages (
  id uuid primary key default gen_random_uuid(),
  message_sid text not null unique,
  from_phone text not null,
  to_phone text,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.inbound_messages enable row level security;

-- This MVP uses the Supabase service role key from server-only Next.js routes.
-- No browser/client table access is needed, so no public RLS policies are added.
