create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  name text,
  phone text not null,
  message text,
  source text not null check (source in ('missed_call', 'intake_form')),
  status text not null default 'new' check (status in ('new')),
  created_at timestamptz not null default now()
);

create index if not exists leads_created_at_idx on public.leads (created_at desc);

alter table public.leads enable row level security;

-- This MVP uses the Supabase service role key from server-only Next.js routes.
-- No browser/client table access is needed, so no public RLS policies are added.
