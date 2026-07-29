-- Direct cutover to confidence-gated GPT-4o transcription and
-- evidence-validated summaries. This migration is additive and idempotent.
alter table public.leads
  add column if not exists voicemail_raw_transcript text,
  add column if not exists voicemail_transcription_model text,
  add column if not exists voicemail_transcription_confidence double precision,
  add column if not exists voicemail_transcription_quality text,
  add column if not exists voicemail_transcription_quality_reasons text[],
  add column if not exists voicemail_transcription_metrics jsonb,
  add column if not exists voicemail_summary_classification text,
  add column if not exists voicemail_summary_evidence text[],
  add column if not exists voicemail_summary_validation_reasons text[];

alter table public.leads
  drop constraint if exists leads_voicemail_transcription_confidence_check;
alter table public.leads
  add constraint leads_voicemail_transcription_confidence_check check (
    voicemail_transcription_confidence is null
    or (
      voicemail_transcription_confidence >= 0
      and voicemail_transcription_confidence <= 1
    )
  );

alter table public.leads
  drop constraint if exists leads_voicemail_transcription_quality_check;
alter table public.leads
  add constraint leads_voicemail_transcription_quality_check check (
    voicemail_transcription_quality is null
    or voicemail_transcription_quality in ('reliable', 'review_recommended', 'unavailable')
  );

comment on column public.leads.voicemail_transcription_confidence is
  'Geometric-mean token confidence derived from provider log probabilities, in the range 0 to 1.';
comment on column public.leads.voicemail_transcription_quality is
  'Fail-closed quality decision. Only reliable transcripts may be shown or summarized.';
comment on column public.leads.voicemail_transcription_metrics is
  'Aggregate confidence metrics only; token-level text/logprobs are not duplicated here.';
comment on column public.leads.voicemail_summary_evidence is
  'Exact transcript excerpts supplied as evidence for the generated summary.';
