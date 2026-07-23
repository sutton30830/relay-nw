-- Phase 2: one technical setup state machine.
--
-- This compatibility migration keeps the legacy values temporarily so the
-- application can roll forward safely. A later cleanup migration will narrow
-- onboarding_status to the five customer-experience contract values.

alter table public.accounts
  alter column onboarding_status set default 'setting_up';

alter table public.accounts
  drop constraint if exists accounts_onboarding_status_check;

alter table public.accounts
  add constraint accounts_onboarding_status_check
  check (
    onboarding_status in (
      'setting_up',
      'waiting_for_forwarding',
      'live',
      'paused',
      'closed',
      'requirements_needed',
      'waiting_on_customer',
      'ready_for_carrier',
      'carrier_review',
      'carrier_attention',
      'ready_for_live_test',
      'ready_to_activate',
      'activated',
      'paused_incomplete',
      'closed_incomplete'
    )
  );

alter table public.account_settings
  drop constraint if exists account_settings_a2p_registration_status_check;

alter table public.account_settings
  add constraint account_settings_a2p_registration_status_check
  check (
    a2p_registration_status in (
      'not_started',
      'in_progress',
      'approved',
      'needs_attention',
      'rejected',
      'paused'
    )
  );

-- Preserve explicit service holds before considering positive call evidence.
update public.accounts
set
  onboarding_status = 'paused',
  onboarding_status_updated_at = coalesce(onboarding_status_updated_at, now())
where onboarding_status = 'paused_incomplete';

update public.accounts
set
  onboarding_status = 'closed',
  onboarding_status_updated_at = coalesce(onboarding_status_updated_at, now())
where onboarding_status = 'closed_incomplete';

-- A real missed-call lead is the only historical evidence that marks calls
-- live. Billing, activation dates, A2P, and synthetic health checks are ignored.
update public.accounts as account
set
  onboarding_status = 'live',
  onboarding_status_updated_at = coalesce(
    (
      select min(lead.created_at)
      from public.leads as lead
      where lead.account_id = account.id
        and lead.source = 'missed_call'
        and lead.deleted_at is null
    ),
    account.onboarding_status_updated_at,
    now()
  )
where account.onboarding_status not in ('paused', 'closed')
  and exists (
    select 1
    from public.leads as lead
    where lead.account_id = account.id
      and lead.source = 'missed_call'
      and lead.deleted_at is null
  );

-- Forwarding accounts with an assigned Relay number are waiting on the one
-- customer action. All other pre-live accounts remain Relay's setup work.
update public.accounts as account
set
  onboarding_status = case
    when settings.call_mode = 'forwarding'
      and exists (
        select 1
        from public.account_phone_numbers as number
        where number.account_id = account.id
      )
      then 'waiting_for_forwarding'
    else 'setting_up'
  end,
  onboarding_status_updated_at = coalesce(account.onboarding_status_updated_at, now())
from public.account_settings as settings
where settings.account_id = account.id
  and account.onboarding_status not in ('live', 'paused', 'closed');

-- Insert the lead and transition technical setup in one transaction. The
-- application passes p_twilio_signature_valid=false for local unsigned
-- overrides, which may create a diagnostic lead but can never mark setup live.
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

-- Verification:
-- select onboarding_status, count(*) from public.accounts group by 1 order by 1;
-- select proname, prosecdef from pg_proc
--   where proname = 'create_missed_call_lead_and_mark_live';
