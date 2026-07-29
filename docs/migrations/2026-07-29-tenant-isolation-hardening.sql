-- Phase 2: multi-business isolation hardening.
--
-- Additive/idempotent migration. It deliberately fails before adding
-- constraints if legacy data violates tenant ownership assumptions. Do not
-- "repair" those rows automatically: investigate their provenance first.

do $$
declare
  v_table text;
  v_null_count bigint;
begin
  foreach v_table in array array[
    'account_settings',
    'account_carrier_profiles',
    'account_phone_numbers',
    'account_users',
    'account_audit_events',
    'leads',
    'opt_outs',
    'inbound_messages',
    'calls',
    'messages'
  ]
  loop
    execute format(
      'select count(*) from public.%I where account_id is null',
      v_table
    ) into v_null_count;

    if v_null_count > 0 then
      raise exception
        'Tenant isolation preflight failed: %.account_id has % null rows',
        v_table,
        v_null_count;
    end if;
  end loop;

  if exists (
    select 1
    from public.account_phone_numbers
    where phone_number !~ '^\+[1-9][0-9]{7,14}$'
  ) then
    raise exception
      'Tenant isolation preflight failed: account_phone_numbers contains a non-E.164 number';
  end if;

  if exists (
    select 1
    from public.account_phone_numbers
    where is_primary
    group by account_id
    having count(*) > 1
  ) then
    raise exception
      'Tenant isolation preflight failed: an account has multiple primary Relay numbers';
  end if;

  if exists (
    select 1
    from public.calls as call
    join public.leads as lead on lead.id = call.lead_id
    where call.lead_id is not null
      and call.account_id <> lead.account_id
  ) then
    raise exception
      'Tenant isolation preflight failed: calls contain a cross-account lead reference';
  end if;

  if exists (
    select 1
    from public.messages as message
    join public.leads as lead on lead.id = message.lead_id
    where message.lead_id is not null
      and message.account_id <> lead.account_id
  ) then
    raise exception
      'Tenant isolation preflight failed: messages contain a cross-account lead reference';
  end if;

  if exists (
    select 1
    from public.messages as message
    join public.calls as call on call.id = message.call_id
    where message.call_id is not null
      and message.account_id <> call.account_id
  ) then
    raise exception
      'Tenant isolation preflight failed: messages contain a cross-account call reference';
  end if;

  if exists (
    with call_evidence as (
      select call_sid as provider_sid, account_id
      from public.calls
      where call_sid is not null
      union all
      select call_sid as provider_sid, account_id
      from public.leads
      where call_sid is not null
    )
    select 1
    from call_evidence
    group by provider_sid
    having count(distinct account_id) > 1
  ) then
    raise exception
      'Tenant isolation preflight failed: a CallSid resolves to multiple accounts';
  end if;

  if exists (
    with message_evidence as (
      select twilio_message_sid as provider_sid, account_id
      from public.messages
      where twilio_message_sid is not null
      union all
      select message_sid as provider_sid, account_id
      from public.inbound_messages
      where message_sid is not null
      union all
      select twilio_message_sid as provider_sid, account_id
      from public.leads
      where twilio_message_sid is not null
    )
    select 1
    from message_evidence
    group by provider_sid
    having count(distinct account_id) > 1
  ) then
    raise exception
      'Tenant isolation preflight failed: a MessageSid resolves to multiple accounts';
  end if;

  if exists (
    with recording_evidence as (
      select recording_sid as provider_sid, account_id
      from public.calls
      where recording_sid is not null
      union all
      select recording_sid as provider_sid, account_id
      from public.leads
      where recording_sid is not null
    )
    select 1
    from recording_evidence
    group by provider_sid
    having count(distinct account_id) > 1
  ) then
    raise exception
      'Tenant isolation preflight failed: a RecordingSid resolves to multiple accounts';
  end if;
end
$$;

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

-- The current platform has one configured Twilio project. A number therefore
-- has one owner at a time, and an account has at most one primary number.
create unique index if not exists account_phone_numbers_phone_unique_idx
  on public.account_phone_numbers (phone_number);

create unique index if not exists account_phone_numbers_one_primary_per_account_idx
  on public.account_phone_numbers (account_id)
  where is_primary;

create unique index if not exists account_phone_numbers_account_twilio_sid_unique_idx
  on public.account_phone_numbers (account_id, twilio_sid)
  where twilio_sid is not null;

-- Twilio object idempotency is tenant-aware. Resolution code additionally
-- rejects an identifier if it resolves to more than one account.
create unique index if not exists leads_account_recording_sid_unique_idx
  on public.leads (account_id, recording_sid)
  where recording_sid is not null;

create unique index if not exists calls_account_recording_sid_unique_idx
  on public.calls (account_id, recording_sid)
  where recording_sid is not null;

-- Composite keys let foreign keys prove that a child row and its related
-- lead/call belong to the same account.
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

-- Serializes assignment by phone number and refuses to steal a number from any
-- other account. Reassignment requires the explicit closed-account release
-- function below.
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
  set
    is_primary = false,
    updated_at = now()
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

-- Locks the account and rechecks closed state in the same transaction as the
-- delete. This prevents a stale Operations page from releasing another
-- account's number or releasing a number after the account was reopened.
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
