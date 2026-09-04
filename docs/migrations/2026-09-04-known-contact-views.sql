-- Step 4. Apply after the contact foundation and SMS migrations.
-- Current contact metadata is a read projection; no historical rows are edited.
create or replace view public.lead_contact_context with (security_invoker = true) as
select l.id, l.account_id, l.call_sid, l.name, l.phone, l.message, l.notes, l.booked_at, l.job_value_cents, l.reply_priority_override, l.priority, l.priority_reason, l.source, l.status, l.sms_status, l.sms_error, l.twilio_message_sid, l.sms_updated_at, l.recording_sid, l.recording_url, l.recording_duration, l.recording_status, l.voicemail_transcript, l.voicemail_summary, l.voicemail_transcription_status, l.voicemail_transcription_error, l.voicemail_transcribed_at, l.deleted_at, l.created_at, c.id as contact_id, c.display_name as contact_name,
  c.classification as contact_classification, c.auto_sms_policy as contact_auto_sms_policy,
  c.version as contact_version, coalesce(c.classification = 'personal',false) as is_personal,
  coalesce(nullif(btrim(l.name),''),c.display_name) as display_name
from public.leads l left join public.account_known_contacts c
  on c.account_id = l.account_id and c.phone = public.known_contact_phone_key(l.phone);
revoke all on public.lead_contact_context from public,anon,authenticated;
grant select on public.lead_contact_context to service_role;

create or replace function public.lead_inbox_context(p_account uuid)
returns setof public.lead_contact_context language sql stable set search_path = public as $$
  select distinct on (phone,(deleted_at is null)) * from public.lead_contact_context
  where account_id = p_account order by phone,(deleted_at is null),created_at desc,id desc;
$$;

create or replace function public.lead_inbox_counts_v2(p_account uuid)
returns jsonb language sql stable set search_path = public as $$
  with cards as (select * from public.lead_inbox_context(p_account)),
  business as (select * from cards where deleted_at is null and not is_personal)
  select jsonb_build_object(
    'all_count',count(*),
    'new_count',count(*) filter(where status = 'new'),
    'contacted_count',count(*) filter(where status = 'contacted'),
    'actionable_count',count(*) filter(where status in ('new','contacted')),
    'dead_count',count(*) filter(where status in ('dead','booked')),
    'booked_count',count(*) filter(where booked_at is not null or status = 'booked'),
    'trash_count',(select count(*) from cards where deleted_at is not null),
    'personal_count',(select count(*) from cards where deleted_at is null and is_personal),
    'sms_issues_count',count(*) filter(where status = 'new' and sms_status in ('failed','undelivered')),
    'sms_blocked_count',count(*) filter(where status = 'new' and sms_status = 'blocked_pre_send'),
    'known_contact_skipped_count',count(*) filter(where sms_status = 'skipped_known_contact'),
    'booked_value_cents',coalesce(sum(job_value_cents) filter(where booked_at is not null or status = 'booked'),0),
    'booked_with_value_count',count(*) filter(where (booked_at is not null or status = 'booked') and job_value_cents > 0)
  ) from business;
$$;

create or replace function public.search_lead_inbox_v2(p_account uuid,p_filter text,p_query text,p_limit int,p_offset int)
returns jsonb language plpgsql stable set search_path = public as $$
declare result jsonb;
begin
  if p_account is null or p_filter is null or p_filter not in ('all','new','contacted','booked','dead','personal','trash')
    or p_limit is null or p_limit not between 1 and 250 or p_offset is null or p_offset < 0 or p_query is null or length(p_query) > 200 then
    raise exception using errcode = '22023', message = 'Invalid inbox query';
  end if;
  with cards as (select * from public.lead_inbox_context(p_account)),
  filtered as (
    select * from cards where
      case when p_filter = 'trash' then deleted_at is not null
        when p_filter = 'personal' then deleted_at is null and is_personal
        else deleted_at is null and not is_personal and (
          p_filter = 'all' or (p_filter = 'booked' and (booked_at is not null or status = 'booked'))
          or (p_filter = 'dead' and status in ('dead','booked')) or (p_filter in ('new','contacted') and status = p_filter)
        ) end
      and (p_query = '' or position(lower(p_query) in lower(
        coalesce(display_name,'Unknown caller') || ' ' || phone || ' ' || coalesce(message,'') || ' ' ||
        coalesce(notes,'') || ' ' || coalesce(voicemail_summary,'') || ' ' || coalesce(voicemail_transcript,'')
      )) > 0)
  ), page as (select * from filtered order by created_at desc,id desc limit p_limit offset p_offset),
  rows as (
    select p.*, (select count(*) from public.leads l where l.account_id = p_account and l.phone = p.phone) as call_count
    from page p
  ) select jsonb_build_object(
    'leads',coalesce((select jsonb_agg(to_jsonb(rows) order by created_at desc,id desc) from rows),'[]'::jsonb),
    'total',(select count(*) from filtered)
  ) into result;
  return result;
end $$;

-- Shared account-scoped reply eligibility. inbound_messages is the single
-- counting source. A mirrored message only supplies a verified lead link.
create or replace function public.account_business_replies(p_account uuid,p_since timestamptz,p_until timestamptz)
returns table(id uuid,linked_lead_id uuid) language sql stable set search_path = public as $$
  select i.id,linked.id
  from public.inbound_messages i
  left join public.account_known_contacts c on c.account_id = p_account and c.phone = public.known_contact_phone_key(i.from_phone)
  left join public.messages m on m.account_id = p_account and m.direction = 'inbound' and m.twilio_message_sid = i.message_sid
  left join public.lead_contact_context linked on linked.account_id = p_account and linked.id = m.lead_id
  where i.account_id = p_account and (p_since is null or i.created_at >= p_since) and (p_until is null or i.created_at < p_until)
    and coalesce(c.classification <> 'personal',true)
    and (linked.id is null or (linked.deleted_at is null and not linked.is_personal))
    and (linked.id is not null or not exists(
      select 1 from public.leads history where history.account_id = p_account
        and public.known_contact_phone_key(history.phone) = public.known_contact_phone_key(i.from_phone)
    ) or exists(
      select 1 from public.lead_contact_context live where live.account_id = p_account and live.deleted_at is null and not live.is_personal
        and public.known_contact_phone_key(live.phone) = public.known_contact_phone_key(i.from_phone)
    ));
$$;

create or replace function public.account_business_recovery_stats(p_account uuid,p_since timestamptz,p_until timestamptz)
returns jsonb language sql stable set search_path = public as $$
  with business as (
    select * from public.lead_contact_context where account_id = p_account and deleted_at is null and not is_personal
  ), activity as (
    select * from business where (p_since is null or created_at >= p_since) and (p_until is null or created_at < p_until)
  ), bookings as (
    select * from business where booked_at is not null and (p_since is null or booked_at >= p_since) and (p_until is null or booked_at < p_until)
  ), replies as (select * from public.account_business_replies(p_account,p_since,p_until))
  select jsonb_build_object(
    'missedCalls',count(*) filter(where source = 'missed_call'),
    'textedBack',count(*) filter(where sms_status in ('sent','delivered')),
    'smsFailed',count(*) filter(where sms_status in ('failed','undelivered')),
    'knownContactSkipped',count(*) filter(where sms_status = 'skipped_known_contact'),
    'preSendBlocked',count(*) filter(where sms_status = 'blocked_pre_send'),
    'urgent',count(*) filter(where priority = 'fast'),
    'replies',(select count(*) from replies),
    'uniqueReplyLeads',(select count(distinct linked_lead_id) from replies),
    'unlinkedReplyCount',(select count(*) from replies where linked_lead_id is null),
    'booked',(select count(*) from bookings),
    'bookedMissingValue',(select count(*) from bookings where coalesce(job_value_cents,0) <= 0),
    'recoveredCents',coalesce((select sum(job_value_cents) from bookings),0)
  ) from activity;
$$;

create or replace function public.account_business_response_stats(p_account uuid,p_since timestamptz,p_until timestamptz)
returns jsonb language sql stable set search_path = public as $$
  with samples as (
    select extract(epoch from (first_outbound.created_at - l.created_at)) as seconds
    from public.lead_contact_context l
    cross join lateral (
      select min(m.created_at) as created_at from public.messages m
      where m.account_id = p_account and m.lead_id = l.id and m.direction = 'outbound'
    ) first_outbound
    where l.account_id = p_account and not l.is_personal and l.deleted_at is null and l.source = 'missed_call'
      and (p_since is null or l.created_at >= p_since) and (p_until is null or l.created_at < p_until)
      and first_outbound.created_at >= l.created_at
  ) select jsonb_build_object('medianSeconds',percentile_cont(0.5) within group(order by seconds),'sampleSize',count(*)) from samples;
$$;

-- These functions and the view are server-only. Service role bypasses RLS, so
-- account predicates remain mandatory in every server call and SQL join.
revoke all on function public.lead_inbox_context(uuid),public.lead_inbox_counts_v2(uuid),public.search_lead_inbox_v2(uuid,text,text,int,int),
  public.account_business_replies(uuid,timestamptz,timestamptz),public.account_business_recovery_stats(uuid,timestamptz,timestamptz),
  public.account_business_response_stats(uuid,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.lead_inbox_context(uuid),public.lead_inbox_counts_v2(uuid),public.search_lead_inbox_v2(uuid,text,text,int,int),
  public.account_business_replies(uuid,timestamptz,timestamptz),public.account_business_recovery_stats(uuid,timestamptz,timestamptz),
  public.account_business_response_stats(uuid,timestamptz,timestamptz) to service_role;
