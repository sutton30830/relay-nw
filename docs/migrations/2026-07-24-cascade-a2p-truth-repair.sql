-- Idempotent repair for Cascade Plumbing's unsupported A2P approval.
-- The account was marked approved without a campaign SID while texting was off.
-- Preserve the assigned Relay number and call readiness; remove only the false
-- carrier evidence and record the repair in the account audit trail.
do $repair$
declare
  v_account_id uuid;
  v_repaired boolean := false;
begin
  select a.id
  into v_account_id
  from public.accounts a
  join public.account_phone_numbers p
    on p.account_id = a.id
   and p.phone_number = '+14253683980'
  join public.account_settings s
    on s.account_id = a.id
  join public.account_carrier_profiles c
    on c.account_id = a.id
  where a.slug = 'cascade-plumbing-sample'
    and s.sms_enabled = false
    and s.a2p_registration_status = 'approved'
    and c.status = 'approved'
    and c.twilio_campaign_sid is null
  for update of a, s, c;

  if v_account_id is not null then
    update public.account_settings
    set
      a2p_registration_status = 'not_started',
      updated_at = now()
    where account_id = v_account_id;

    update public.account_carrier_profiles
    set
      status = 'draft',
      twilio_brand_sid = null,
      twilio_campaign_sid = null,
      messaging_service_sid = null,
      status_detail = 'Reset because no Twilio campaign or number-registration evidence supported the prior approval.',
      updated_at = now()
    where account_id = v_account_id;

    v_repaired := true;
  end if;

  if v_repaired then
    insert into public.account_audit_events (
      account_id,
      actor_user_id,
      actor_email,
      action,
      summary
    )
    values (
      v_account_id,
      null,
      'system:a2p-truth-repair',
      'carrier.false_approval_repaired',
      'Reset unsupported A2P approval to not started; no campaign SID or number-registration evidence existed.'
    );
  end if;
end
$repair$;

select
  a.slug,
  s.a2p_registration_status,
  s.sms_enabled,
  c.status as carrier_status,
  c.twilio_campaign_sid,
  c.messaging_service_sid,
  exists (
    select 1
    from public.account_audit_events e
    where e.account_id = a.id
      and e.action = 'carrier.false_approval_repaired'
  ) as repair_audited
from public.accounts a
join public.account_settings s on s.account_id = a.id
left join public.account_carrier_profiles c on c.account_id = a.id
where a.slug = 'cascade-plumbing-sample';
