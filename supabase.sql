create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  call_sid text,
  name text,
  phone text not null,
  message text,
  source text not null check (source in ('missed_call', 'intake_form')),
  status text not null default 'new' check (status in ('new', 'contacted', 'booked', 'dead')),
  created_at timestamptz not null default now()
);

alter table public.leads add column if not exists call_sid text;
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads
  add constraint leads_status_check check (status in ('new', 'contacted', 'booked', 'dead'));

create index if not exists leads_created_at_idx on public.leads (created_at desc);
create unique index if not exists leads_call_sid_unique_idx
  on public.leads (call_sid)
  where call_sid is not null;

alter table public.leads enable row level security;

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null check (source in ('twilio_voice', 'twilio_dial_status')),
  payload jsonb not null default '{}'::jsonb,
  response_status integer not null,
  response_body text,
  error text
);

alter table public.webhook_events enable row level security;

-- This MVP uses the Supabase service role key from server-only Next.js routes.
-- No browser/client table access is needed, so no public RLS policies are added.
