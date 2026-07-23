-- Repair the missed-call activation RPC after obsolete setup columns were removed.
-- Safe to run repeatedly.

begin;

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

commit;

-- Verification: both values should be true.
select
  to_regprocedure(
    'public.create_missed_call_lead_and_mark_live(uuid,text,text,text,boolean)'
  ) is not null as function_exists,
  position(
    'requirements_due_at' in pg_get_functiondef(
      'public.create_missed_call_lead_and_mark_live(uuid,text,text,text,boolean)'::regprocedure
    )
  ) = 0 as obsolete_column_reference_removed;
