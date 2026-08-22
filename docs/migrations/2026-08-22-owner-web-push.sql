-- Owner-enabled, device-specific Web Push subscriptions.
-- Apply before deploying code that writes owner_push_subscriptions.
create table if not exists public.owner_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check (length(endpoint) between 1 and 2048 and endpoint like 'https://%'),
  p256dh text not null check (length(p256dh) between 40 and 255),
  auth text not null check (length(auth) between 8 and 255),
  user_agent text,
  missed_call_enabled boolean not null default true,
  voicemail_ready_enabled boolean not null default true,
  failure_count integer not null default 0 check (failure_count >= 0),
  last_success_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A browser subscription is shared across sessions for this origin. Keeping the
-- endpoint globally unique transfers a shared device to its latest signed-in
-- account instead of leaking alerts from an account that previously used it.
alter table public.owner_push_subscriptions
  drop constraint if exists owner_push_subscriptions_account_id_user_id_endpoint_key;
create unique index if not exists owner_push_subscriptions_endpoint_key
  on public.owner_push_subscriptions (endpoint);

create index if not exists owner_push_subscriptions_delivery_idx
  on public.owner_push_subscriptions (account_id, disabled_at)
  where disabled_at is null;

alter table public.owner_push_subscriptions enable row level security;
drop policy if exists deny_client_access on public.owner_push_subscriptions;
create policy deny_client_access on public.owner_push_subscriptions
  as restrictive for all to anon, authenticated using (false) with check (false);

comment on table public.owner_push_subscriptions is
  'Owner-opted-in browser push endpoints, scoped to both the authenticated user and tenant account.';
