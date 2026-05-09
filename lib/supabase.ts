import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

const LEAD_SELECT_COLUMNS =
  "id, call_sid, name, phone, message, notes, booked_at, job_value_cents, reply_priority_override, source, status, sms_status, sms_error, twilio_message_sid, sms_updated_at, recording_sid, recording_url, recording_duration, recording_status, voicemail_transcript, voicemail_summary, voicemail_transcription_status, voicemail_transcription_error, voicemail_transcribed_at, created_at";
const LEGACY_LEAD_SELECT_COLUMNS =
  "id, call_sid, name, phone, message, notes, job_value_cents, source, status, sms_status, sms_error, twilio_message_sid, sms_updated_at, recording_sid, recording_url, recording_duration, recording_status, created_at";

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
  payload: Record<string, unknown>;
  response_status: number;
  response_body: string | null;
  error: string | null;
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
  created_at: string;
};

export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastRetentionSweepAt = 0;

function isPlaceholderSupabaseConfig() {
  return (
    env.supabaseUrl.includes("example.supabase.co") ||
    env.supabaseServiceRoleKey === "test-service-role-key" ||
    env.supabaseServiceRoleKey.includes("your_service_role_key")
  );
}

function shouldSkipDatabaseWrite(action: string, details?: unknown) {
  if (!isPlaceholderSupabaseConfig()) {
    return false;
  }

  console.warn(`Skipping ${action} because Supabase is using placeholder values.`, details);
  return true;
}

function throwIfSupabaseError(error: { message: string } | null) {
  if (error) {
    throw error;
  }
}

function isMissingBookedAtColumnError(error: { message: string } | null) {
  return Boolean(error?.message.includes("booked_at"));
}

function isMissingReplyPriorityColumnError(error: { message: string } | null) {
  return Boolean(error?.message.includes("reply_priority_override"));
}

function isMissingOptionalLeadColumnError(error: { message: string } | null) {
  return Boolean(
    error?.message.includes("booked_at") ||
      error?.message.includes("voicemail_transcript") ||
      error?.message.includes("voicemail_summary") ||
      error?.message.includes("voicemail_transcription_status") ||
      error?.message.includes("voicemail_transcription_error") ||
      error?.message.includes("voicemail_transcribed_at") ||
      error?.message.includes("reply_priority_override"),
  );
}

function normalizeLead(lead: Lead): Lead {
  const normalizedLead = {
    ...lead,
    voicemail_transcript: lead.voicemail_transcript ?? null,
    voicemail_summary: lead.voicemail_summary ?? null,
    voicemail_transcription_status: lead.voicemail_transcription_status ?? null,
    voicemail_transcription_error: lead.voicemail_transcription_error ?? null,
    voicemail_transcribed_at: lead.voicemail_transcribed_at ?? null,
    reply_priority_override: lead.reply_priority_override ?? null,
  };

  if (normalizedLead.status !== "booked") {
    return normalizedLead;
  }

  return {
    ...normalizedLead,
    booked_at: normalizedLead.booked_at ?? normalizedLead.created_at,
    status: "dead",
  };
}

function lastFour(value: string | undefined) {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) {
    return null;
  }

  return digits.slice(-4);
}

function stringValue(payload: Record<string, string>, key: string) {
  return payload[key]?.trim() || null;
}

function sanitizedWebhookPayload(payload: Record<string, string>) {
  const body = stringValue(payload, "Body");

  return {
    callSid: stringValue(payload, "CallSid"),
    parentCallSid: stringValue(payload, "ParentCallSid"),
    dialCallSid: stringValue(payload, "DialCallSid"),
    messageSid: stringValue(payload, "MessageSid") ?? stringValue(payload, "SmsSid"),
    recordingSid: stringValue(payload, "RecordingSid"),
    fromLast4: lastFour(payload.From),
    toLast4: lastFour(payload.To),
    calledLast4: lastFour(payload.Called),
    callerLast4: lastFour(payload.Caller),
    dialCallStatus: stringValue(payload, "DialCallStatus"),
    callStatus: stringValue(payload, "CallStatus"),
    messageStatus: stringValue(payload, "MessageStatus") ?? stringValue(payload, "SmsStatus"),
    recordingStatus: stringValue(payload, "RecordingStatus"),
    recordingDuration: stringValue(payload, "RecordingDuration"),
    errorCode: stringValue(payload, "ErrorCode"),
    hasBody: Boolean(body),
    bodyLength: body?.length ?? null,
  };
}

function retentionCutoff(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function pruneOldOperationalData() {
  const now = Date.now();

  if (now - lastRetentionSweepAt < RETENTION_SWEEP_INTERVAL_MS) {
    return;
  }

  lastRetentionSweepAt = now;

  const webhookCutoff = retentionCutoff(env.webhookEventRetentionDays);
  const inboundMessageCutoff = retentionCutoff(env.inboundMessageRetentionDays);

  const { error: webhookError } = await supabaseAdmin
    .from("webhook_events")
    .delete()
    .lt("created_at", webhookCutoff);

  if (webhookError) {
    console.error("Failed to prune old webhook events", webhookError);
  }

  const { error: inboundMessageError } = await supabaseAdmin
    .from("inbound_messages")
    .delete()
    .lt("created_at", inboundMessageCutoff);

  if (inboundMessageError) {
    console.error("Failed to prune old inbound messages", inboundMessageError);
  }
}

export async function createLead(input: {
  name?: string | null;
  phone: string;
  message?: string | null;
  source: LeadSource;
  callSid?: string | null;
}) {
  if (shouldSkipDatabaseWrite("lead insert", input)) {
    return;
  }

  const { error } = await supabaseAdmin.from("leads").insert({
    call_sid: input.callSid ?? null,
    name: input.name ?? null,
    phone: input.phone,
    message: input.message ?? null,
    source: input.source,
    status: "new",
  });

  throwIfSupabaseError(error);
}

export async function createMissedCallLeadIfNew(input: {
  callSid: string;
  phone: string;
  message: string | null;
}) {
  if (shouldSkipDatabaseWrite("missed call lead insert", input)) {
    return { inserted: true, leadId: null };
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .insert({
      call_sid: input.callSid,
      phone: input.phone,
      message: input.message,
      sms_status: "pending",
      source: "missed_call",
      status: "new",
    })
    .select("id")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return { inserted: false, leadId: null };
    }

    throw error;
  }

  return {
    inserted: Boolean(data?.id),
    leadId: data?.id ?? null,
  };
}

export async function getLeads() {
  if (isPlaceholderSupabaseConfig()) {
    return [] as Lead[];
  }

  const query = supabaseAdmin
    .from("leads")
    .select(LEAD_SELECT_COLUMNS)
    .order("created_at", { ascending: false });
  const { data, error } = await query;

  if (isMissingOptionalLeadColumnError(error)) {
    console.warn("Some optional leads columns are missing. Run supabase.sql to enable all inbox features.");

    const { data: legacyData, error: legacyError } = await supabaseAdmin
      .from("leads")
      .select(LEGACY_LEAD_SELECT_COLUMNS)
      .order("created_at", { ascending: false });

    throwIfSupabaseError(legacyError);

    return ((legacyData ?? []).map((lead) => normalizeLead({
      ...lead,
      booked_at: lead.status === "booked" ? lead.created_at : null,
    } as Lead)));
  }

  throwIfSupabaseError(error);

  return ((data ?? []) as Lead[]).map(normalizeLead);
}

export async function getRecentWebhookEvents(limit = 20) {
  if (isPlaceholderSupabaseConfig()) {
    return [] as WebhookEvent[];
  }

  const { data, error } = await supabaseAdmin
    .from("webhook_events")
    .select("id, created_at, source, payload, response_status, response_body, error")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Failed to load recent webhook events", error);
    return [] as WebhookEvent[];
  }

  return (data ?? []) as WebhookEvent[];
}

export async function recordingBelongsToLead(recordingSid: string) {
  if (isPlaceholderSupabaseConfig()) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id")
    .eq("recording_sid", recordingSid)
    .limit(1)
    .maybeSingle();

  throwIfSupabaseError(error);

  return Boolean(data?.id);
}

export async function getLeadForVoicemailTranscription(id: string) {
  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id, recording_sid, voicemail_transcript, voicemail_summary, voicemail_transcription_status")
    .eq("id", id)
    .maybeSingle();

  throwIfSupabaseError(error);

  return data as {
    id: string;
    recording_sid: string | null;
    voicemail_transcript: string | null;
    voicemail_summary: string | null;
    voicemail_transcription_status: VoicemailTranscriptionStatus;
  } | null;
}

export async function updateLeadVoicemailTranscription(input: {
  id: string;
  transcript?: string | null;
  summary?: string | null;
  status: VoicemailTranscriptionStatus;
  error?: string | null;
}) {
  if (shouldSkipDatabaseWrite("voicemail transcription update", input)) {
    return;
  }

  const updates: {
    voicemail_transcript?: string | null;
    voicemail_summary?: string | null;
    voicemail_transcription_status: VoicemailTranscriptionStatus;
    voicemail_transcription_error: string | null;
    voicemail_transcribed_at: string | null;
  } = {
    voicemail_transcription_status: input.status,
    voicemail_transcription_error: input.error ?? null,
    voicemail_transcribed_at: input.status === "completed" ? new Date().toISOString() : null,
  };

  if (typeof input.transcript !== "undefined") {
    updates.voicemail_transcript = input.transcript;
  }

  if (typeof input.summary !== "undefined") {
    updates.voicemail_summary = input.summary;
  }

  const { error } = await supabaseAdmin
    .from("leads")
    .update(updates)
    .eq("id", input.id);

  throwIfSupabaseError(error);
}

export async function updateLeadRecordingByCallSid(input: {
  callSid: string;
  callerPhone?: string | null;
  recordingSid?: string | null;
  recordingUrl?: string | null;
  recordingDuration?: number | null;
  recordingStatus?: string | null;
}) {
  if (shouldSkipDatabaseWrite("recording update", input)) {
    return { updated: false, leadId: null };
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .update({
      recording_sid: input.recordingSid ?? null,
      recording_url: input.recordingUrl ?? null,
      recording_duration: input.recordingDuration ?? null,
      recording_status: input.recordingStatus ?? null,
    })
    .eq("call_sid", input.callSid)
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(error);

  if (data?.id || !input.callerPhone) {
    return { updated: Boolean(data?.id), leadId: data?.id ?? null, matchedBy: data?.id ? "call_sid" : null };
  }

  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: recentLead, error: recentLeadError } = await supabaseAdmin
    .from("leads")
    .select("id")
    .eq("phone", input.callerPhone)
    .eq("source", "missed_call")
    .is("recording_sid", null)
    .gte("created_at", thirtyMinutesAgo)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  throwIfSupabaseError(recentLeadError);

  if (!recentLead?.id) {
    return { updated: false, leadId: null, matchedBy: null };
  }

  const { data: fallbackData, error: fallbackError } = await supabaseAdmin
    .from("leads")
    .update({
      recording_sid: input.recordingSid ?? null,
      recording_url: input.recordingUrl ?? null,
      recording_duration: input.recordingDuration ?? null,
      recording_status: input.recordingStatus ?? null,
    })
    .eq("id", recentLead.id)
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(fallbackError);

  return {
    updated: Boolean(fallbackData?.id),
    leadId: fallbackData?.id ?? null,
    matchedBy: fallbackData?.id ? "phone" : null,
  };
}

export async function updateLead(input: {
  id: string;
  name?: string | null;
  status?: LeadStatus;
  notes?: string | null;
  bookedAt?: string | null;
  jobValueCents?: number | null;
  replyPriorityOverride?: ReplyPriorityOverride;
  voicemailSummary?: string | null;
}) {
  if (shouldSkipDatabaseWrite("lead update", input)) {
    return;
  }

  const updates: {
    name?: string | null;
    status?: LeadStatus;
    notes?: string | null;
    booked_at?: string | null;
    job_value_cents?: number | null;
    reply_priority_override?: ReplyPriorityOverride;
    voicemail_summary?: string | null;
  } = {};

  if (typeof input.name !== "undefined") {
    updates.name = input.name;
  }

  if (input.status) {
    updates.status = input.status;
  }

  if (typeof input.notes !== "undefined") {
    updates.notes = input.notes;
  }

  if (typeof input.bookedAt !== "undefined") {
    updates.booked_at = input.bookedAt;
  }

  if (typeof input.jobValueCents !== "undefined") {
    updates.job_value_cents = input.jobValueCents;
  }

  if (typeof input.replyPriorityOverride !== "undefined") {
    updates.reply_priority_override = input.replyPriorityOverride;
  }

  if (typeof input.voicemailSummary !== "undefined") {
    updates.voicemail_summary = input.voicemailSummary;
  }

  if (typeof input.name !== "undefined") {
    const { data: lead, error: leadError } = await supabaseAdmin
      .from("leads")
      .select("phone")
      .eq("id", input.id)
      .maybeSingle();

    throwIfSupabaseError(leadError);

    if (lead?.phone) {
      const { error: nameError } = await supabaseAdmin
        .from("leads")
        .update({ name: input.name })
        .eq("phone", lead.phone);

      throwIfSupabaseError(nameError);
    }

    delete updates.name;
  }

  if (Object.keys(updates).length === 0) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("leads")
    .update(updates)
    .eq("id", input.id);

  if (isMissingBookedAtColumnError(error) && typeof updates.booked_at !== "undefined") {
    console.warn("leads.booked_at is missing. Run supabase.sql to persist booked outcome tracking.");
    const legacyUpdates = { ...updates };
    delete legacyUpdates.booked_at;

    if (Object.keys(legacyUpdates).length === 0) {
      return;
    }

    const { error: legacyError } = await supabaseAdmin
      .from("leads")
      .update(legacyUpdates)
      .eq("id", input.id);

    throwIfSupabaseError(legacyError);
    return;
  }

  if (isMissingReplyPriorityColumnError(error) && typeof updates.reply_priority_override !== "undefined") {
    console.warn("leads.reply_priority_override is missing. Run supabase.sql to persist manual reply priority.");
    const legacyUpdates = { ...updates };
    delete legacyUpdates.reply_priority_override;

    if (Object.keys(legacyUpdates).length === 0) {
      return;
    }

    const { error: legacyError } = await supabaseAdmin
      .from("leads")
      .update(legacyUpdates)
      .eq("id", input.id);

    throwIfSupabaseError(legacyError);
    return;
  }

  throwIfSupabaseError(error);
}

export async function updateLeadSmsStatus(input: {
  id: string;
  smsStatus: Exclude<SmsStatus, null>;
  smsError?: string | null;
  twilioMessageSid?: string | null;
}) {
  if (shouldSkipDatabaseWrite("SMS status update", input)) {
    return;
  }

  const updates: {
    sms_status: Exclude<SmsStatus, null>;
    sms_error: string | null;
    sms_updated_at: string;
    twilio_message_sid?: string | null;
  } = {
    sms_status: input.smsStatus,
    sms_error: input.smsError ?? null,
    sms_updated_at: new Date().toISOString(),
  };

  if (typeof input.twilioMessageSid !== "undefined") {
    updates.twilio_message_sid = input.twilioMessageSid;
  }

  const { error } = await supabaseAdmin
    .from("leads")
    .update(updates)
    .eq("id", input.id);

  throwIfSupabaseError(error);
}

export async function updateLeadSmsStatusByMessageSid(input: {
  twilioMessageSid: string;
  smsStatus: Exclude<SmsStatus, null>;
  smsError?: string | null;
}) {
  if (shouldSkipDatabaseWrite("SMS status callback update", input)) {
    return { updated: false };
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .update({
      sms_status: input.smsStatus,
      sms_error: input.smsError ?? null,
      sms_updated_at: new Date().toISOString(),
    })
    .eq("twilio_message_sid", input.twilioMessageSid)
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(error);

  return { updated: Boolean(data?.id), leadId: data?.id ?? null };
}

export async function hasRecentMissedCallSms(phone: string, since: Date) {
  if (isPlaceholderSupabaseConfig()) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id")
    .eq("phone", phone)
    .eq("source", "missed_call")
    .in("sms_status", ["pending", "queued", "sending", "sent", "delivered"])
    .gte("created_at", since.toISOString())
    .limit(1);

  throwIfSupabaseError(error);

  return Boolean(data?.length);
}

export async function isOptedOut(phone: string) {
  if (isPlaceholderSupabaseConfig()) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from("opt_outs")
    .select("phone")
    .eq("phone", phone)
    .maybeSingle();

  throwIfSupabaseError(error);

  return Boolean(data);
}

export async function recordOptOut(phone: string) {
  if (shouldSkipDatabaseWrite("opt-out insert", { phone })) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("opt_outs")
    .upsert({ phone }, { onConflict: "phone" });

  throwIfSupabaseError(error);
}

export async function createInboundMessageIfNew(input: {
  messageSid: string;
  fromPhone: string;
  toPhone?: string | null;
  body: string;
}) {
  if (shouldSkipDatabaseWrite("inbound message insert", input)) {
    return { inserted: true };
  }

  const { error } = await supabaseAdmin.from("inbound_messages").insert({
    message_sid: input.messageSid,
    from_phone: input.fromPhone,
    to_phone: input.toPhone ?? null,
    body: input.body,
  });

  if (error) {
    if (error.code === "23505") {
      return { inserted: false };
    }

    throw error;
  }

  return { inserted: true };
}

export async function logWebhookEvent(input: {
  source: WebhookEventSource;
  payload: Record<string, string>;
  responseStatus: number;
  responseBody?: string | null;
  error?: string | null;
}) {
  if (isPlaceholderSupabaseConfig()) {
    return;
  }

  await pruneOldOperationalData();

  const { error } = await supabaseAdmin.from("webhook_events").insert({
    source: input.source,
    payload: sanitizedWebhookPayload(input.payload),
    response_status: input.responseStatus,
    response_body: input.responseBody ?? null,
    error: input.error ?? null,
  });

  if (error) {
    console.error("Failed to log webhook event", error);
  }
}
