-- Preserve the speech-to-text provider's original output separately from the
-- customer-facing transcript. Historical rows are intentionally left null:
-- older voicemail_transcript values may have passed through an AI rewrite, so
-- copying them here would incorrectly label rewritten text as raw evidence.
alter table public.leads
  add column if not exists voicemail_raw_transcript text;

comment on column public.leads.voicemail_raw_transcript is
  'Original text returned by the speech-to-text provider before trimming, formatting, summarization, or other downstream processing.';
