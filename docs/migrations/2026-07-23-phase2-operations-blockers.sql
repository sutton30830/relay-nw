-- Phase 2: independent Operations blocker ownership.
-- Idempotent and safe to run more than once.

alter table public.accounts
  add column if not exists ops_blocked_by text not null default 'none';
alter table public.accounts
  add column if not exists ops_blocker_note text;
alter table public.accounts
  add column if not exists ops_blocked_since timestamptz;

-- Existing accounts begin unblocked. These updates also repair any partially
-- applied development version of this migration before constraints are added.
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

alter table public.accounts
  alter column ops_blocked_by set default 'none';
alter table public.accounts
  alter column ops_blocked_by set not null;

alter table public.accounts
  drop constraint if exists accounts_ops_blocked_by_check;
alter table public.accounts
  add constraint accounts_ops_blocked_by_check
  check (ops_blocked_by in ('none', 'relay', 'customer', 'carrier'));

alter table public.accounts
  drop constraint if exists accounts_ops_blocker_consistency_check;
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

-- Blocker ownership and its account audit record change atomically. The
-- application additionally requires an operator write role before invoking
-- this service-role-only function.
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

revoke all on function public.set_account_ops_blocker(
  uuid,
  text,
  text,
  uuid,
  text
) from public, anon, authenticated;
grant execute on function public.set_account_ops_blocker(
  uuid,
  text,
  text,
  uuid,
  text
) to service_role;

-- Verification: one row, zero invalid accounts, and the expected RPC name.
select
  to_regprocedure(
    'public.set_account_ops_blocker(uuid,text,text,uuid,text)'
  ) as ops_blocker_rpc,
  (
    select count(*)
    from public.accounts
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
       )
  ) as invalid_blocker_rows;
