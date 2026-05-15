export type LeadSource = "missed_call" | "intake_form";
export type LeadStatus = "new" | "contacted" | "booked" | "dead";
export type ReplyPriorityOverride = "fast" | "today" | "normal" | null;
export type SmsStatus =
  | "pending"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "undelivered"
  | "skipped_disabled"
  | "skipped_opt_out"
  | "skipped_recent"
  | null;
export type VoicemailTranscriptionStatus = "pending" | "processing" | "completed" | "failed" | null;
export type WebhookEventSource =
  | "twilio_voice"
  | "twilio_dial_status"
  | "twilio_inbound_sms"
  | "twilio_sms_status"
  | "twilio_recording";

export type WebhookEvent = {
  id: string;
  created_at: string;
  source: WebhookEventSource;
  correlation_id: string | null;
  payload: Record<string, unknown>;
  response_status: number;
  response_body: string | null;
  error: string | null;
};

export type InboundMessage = {
  id: string;
  message_sid: string;
  from_phone: string;
  to_phone: string | null;
  body: string;
  created_at: string;
};

export type Lead = {
  id: string;
  call_sid: string | null;
  name: string | null;
  phone: string;
  message: string | null;
  notes: string | null;
  booked_at: string | null;
  job_value_cents: number | null;
  reply_priority_override: ReplyPriorityOverride;
  source: LeadSource;
  status: LeadStatus;
  sms_status: SmsStatus;
  sms_error: string | null;
  twilio_message_sid: string | null;
  sms_updated_at: string | null;
  recording_sid: string | null;
  recording_url: string | null;
  recording_duration: number | null;
  recording_status: string | null;
  voicemail_transcript: string | null;
  voicemail_summary: string | null;
  voicemail_transcription_status: VoicemailTranscriptionStatus;
  voicemail_transcription_error: string | null;
  voicemail_transcribed_at: string | null;
  inbound_messages: InboundMessage[];
  deleted_at: string | null;
  created_at: string;
};
