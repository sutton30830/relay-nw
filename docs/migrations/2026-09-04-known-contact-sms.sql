-- Apply after 2026-09-03-known-contacts.sql and before deploying the SMS gate.
-- Preserve all existing outcomes; do not backfill/replay skipped messages.
alter table public.leads drop constraint if exists leads_sms_status_check;
alter table public.leads add constraint leads_sms_status_check check (
  sms_status in ('pending','queued','sending','sent','delivered','failed','undelivered',
    'skipped_disabled','skipped_opt_out','skipped_recent','skipped_known_contact','blocked_pre_send')
);

-- Automatic missed-call sends have at most one submission per captured lead.
-- Both the send result and a signed callback may report it. Idempotent evidence
-- must not increment twice or overwrite a faster terminal delivery callback.
create or replace function public.record_automatic_sms_attempt(p_account_id uuid, p_action_key text)
returns boolean language plpgsql set search_path = public as $$
begin
  update public.provider_action_events
    set attempt_count = greatest(attempt_count,1), updated_at = now()
    where account_id = p_account_id and idempotency_key = p_action_key
      and action = 'automatic_missed_call_sms' and suppressed = false;
  return found;
end $$;
revoke all on function public.record_automatic_sms_attempt(uuid,text) from public,anon,authenticated;
grant execute on function public.record_automatic_sms_attempt(uuid,text) to service_role;
