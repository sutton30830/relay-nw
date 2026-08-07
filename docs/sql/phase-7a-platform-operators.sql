-- Relay NW Phase 7A: dedicated platform Operations authorization.
-- Safe to run more than once. Run in Supabase SQL Editor as a project owner.

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

-- Deliberately do not bootstrap an identity-specific platform operator here.
-- The first super admin must be granted explicitly by an authorized owner using
-- the evidence-producing procedure in docs/operations/production-access-checklist.md.
-- Reapplying this SQL must never silently grant or restore Operations access.

drop policy if exists deny_client_access on public.platform_operators;
create policy deny_client_access on public.platform_operators
  as restrictive for all to anon, authenticated
  using (false) with check (false);

drop policy if exists deny_client_access on public.platform_audit_events;
create policy deny_client_access on public.platform_audit_events
  as restrictive for all to anon, authenticated
  using (false) with check (false);

-- Verify the bootstrap without exposing any operator details:
select count(*) as active_platform_operators
from public.platform_operators
where status = 'active';
