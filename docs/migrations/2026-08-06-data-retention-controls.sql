-- Run after docs/migrations/2026-08-05-provider-action-events.sql.
alter table public.inbound_messages alter column body drop not null;

create table if not exists public.data_retention_events (
  id uuid primary key default gen_random_uuid(),
  target_account_id uuid,
  actor_user_id uuid,
  actor_email text,
  action text not null,
  status text not null check (status in ('failed', 'completed')),
  counts jsonb not null default '{}'::jsonb,
  failure_kinds text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists data_retention_events_target_created_at_idx on public.data_retention_events (target_account_id, created_at desc) where target_account_id is not null;
alter table public.data_retention_events enable row level security;
drop policy if exists deny_client_access on public.data_retention_events;
create policy deny_client_access on public.data_retention_events as restrictive for all to anon, authenticated using (false) with check (false);

create or replace function public.delete_account_data(p_account_id uuid, p_actor_user_id uuid, p_actor_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_status text; v_technical_status text; v_counts jsonb;
begin
  if p_account_id is null or p_actor_user_id is null then raise exception 'Account id and actor are required'; end if;
  select status, onboarding_status into v_status, v_technical_status from public.accounts where id = p_account_id for update;
  if not found then
    if exists (select 1 from public.data_retention_events where target_account_id = p_account_id and action = 'account.delete' and status = 'completed') then return '{}'::jsonb; end if;
    raise exception 'Account not found';
  end if;
  if v_status <> 'archived' or v_technical_status <> 'closed' then raise exception 'Account must be archived and technically closed before deletion'; end if;
  select jsonb_build_object(
    'accounts', 1,
    'leads', (select count(*) from public.leads where account_id = p_account_id),
    'calls', (select count(*) from public.calls where account_id = p_account_id),
    'messages', (select count(*) from public.messages where account_id = p_account_id),
    'inbound_messages', (select count(*) from public.inbound_messages where account_id = p_account_id),
    'webhook_events', (select count(*) from public.webhook_events where account_id = p_account_id),
    'opt_outs', (select count(*) from public.opt_outs where account_id = p_account_id),
    'account_audit_events', (select count(*) from public.account_audit_events where account_id = p_account_id),
    'provider_action_events', (select count(*) from public.provider_action_events where account_id = p_account_id)
  ) into v_counts;
  delete from public.provider_action_events where account_id = p_account_id;
  delete from public.messages where account_id = p_account_id;
  delete from public.calls where account_id = p_account_id;
  delete from public.inbound_messages where account_id = p_account_id;
  delete from public.opt_outs where account_id = p_account_id;
  delete from public.webhook_events where account_id = p_account_id;
  delete from public.leads where account_id = p_account_id;
  delete from public.accounts where id = p_account_id;
  insert into public.data_retention_events (target_account_id, actor_user_id, actor_email, action, status, counts) values (p_account_id, p_actor_user_id, p_actor_email, 'account.delete', 'completed', v_counts);
  return v_counts;
end; $$;
revoke all on function public.delete_account_data(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.delete_account_data(uuid, uuid, text) to service_role;
