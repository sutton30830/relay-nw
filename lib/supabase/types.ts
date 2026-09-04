export type LeadSource = "missed_call" | "intake_form";
export type LeadStatus = "new" | "contacted" | "booked" | "dead";
// The inbox's filter pills add two views beyond a single status: "all" and
// the soft-deleted "trash" bucket.
export type LeadInboxFilter = LeadStatus | "all" | "trash";
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
  | "skipped_known_contact"
  | "blocked_pre_send"
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
  body: string | null;
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
  error: string | null;
  created_at: string;
  updated_at: string | null;
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
  priority: "fast" | "today" | "normal" | null;
  priority_reason: string | null;
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

export type ContactClassification = "unclassified" | "customer" | "personal";
export type ContactSmsPolicy = "suppress" | "standard";
export type ContactSource = "manual" | "lead" | "csv" | "vcard" | "phone_picker";
export type KnownContact = {
  id: string;
  account_id: string;
  phone: string;
  display_name: string | null;
  classification: ContactClassification;
  auto_sms_policy: ContactSmsPolicy;
  source: ContactSource;
  version: number;
  created_at: string;
  updated_at: string;
};
export type KnownContactMergeResult = { contact: KnownContact; created: boolean };
