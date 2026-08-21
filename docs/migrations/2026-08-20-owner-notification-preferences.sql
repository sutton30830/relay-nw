-- Per-account owner notification controls.
-- Additive, idempotent, and backward compatible: the default JSON exactly
-- preserves Relay's notification behavior before this migration.

begin;

alter table public.account_settings
  add column if not exists notification_preferences jsonb not null default '{
    "missed_call": {"email": true, "sms": true},
    "voicemail_ready": {"email": true, "sms": false},
    "inbound_reply": {"email": true, "sms": true},
    "urgent_voicemail_sms": true
  }'::jsonb;

alter table public.account_settings
  drop constraint if exists account_settings_notification_preferences_object;
alter table public.account_settings
  add constraint account_settings_notification_preferences_object
  check (jsonb_typeof(notification_preferences) = 'object');

comment on column public.account_settings.notification_preferences is
  'Owner-selected delivery channels for missed calls, voicemail summaries, caller replies, and urgent voicemail text overrides.';

commit;
