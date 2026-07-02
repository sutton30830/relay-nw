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
export type ForwardingHealthCheckStatus = "pending" | "passed" | "failed" | "timeout" | "error";
export type ForwardingHealthCheckFailureReason =
  | "no_forwarded_call_received"
  | "twilio_outbound_failed"
  | "webhook_error"
  | "rate_limited"
  | "unknown_error"
  | null;
export type WebhookEventSource =
  | "twilio_voice"
  | "twilio_dial_status"
  | "twilio_inbound_sms"
  | "twilio_sms_status"
  | "twilio_recording";

export type WebhookEvent = {
  id: string;
  account_id?: string | null;
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
  account_id?: string | null;
  message_sid: string;
  from_phone: string;
  to_phone: string | null;
  body: string;
  created_at: string;
};

export type OutboundMessage = {
  id: string;
  account_id?: string | null;
  lead_id: string | null;
  twilio_message_sid: string | null;
  from_phone: string | null;
  to_phone: string | null;
  body: string | null;
  status: string | null;
  created_at: string;
};

export type ForwardingHealthCheck = {
  id: string;
  account_id?: string | null;
  phone_number_tested: string;
  status: ForwardingHealthCheckStatus;
  started_at: string;
  completed_at: string | null;
  outbound_twilio_call_sid: string | null;
  inbound_twilio_call_sid: string | null;
  failure_reason: ForwardingHealthCheckFailureReason;
  raw_event_summary: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type Lead = {
  id: string;
  account_id?: string | null;
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
  outbound_messages: OutboundMessage[];
  deleted_at: string | null;
  created_at: string;
};
