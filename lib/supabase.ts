import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

const LEAD_SELECT_COLUMNS =
  "id, call_sid, name, phone, message, notes, source, status, sms_status, sms_error, twilio_message_sid, sms_updated_at, recording_sid, recording_url, recording_duration, recording_status, created_at";

export type LeadSource = "missed_call" | "intake_form";
export type LeadStatus = "new" | "contacted" | "booked" | "dead";
export type SmsStatus =
  | "pending"
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "undelivered"
  | "skipped_opt_out"
  | "skipped_recent"
  | null;
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
  created_at: string;
};

export const supabaseAdmin = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

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
  message: string;
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

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select(LEAD_SELECT_COLUMNS)
    .order("created_at", { ascending: false });

  throwIfSupabaseError(error);

  return (data ?? []) as Lead[];
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

export async function updateLead(input: { id: string; status?: LeadStatus; notes?: string | null }) {
  if (shouldSkipDatabaseWrite("lead update", input)) {
    return;
  }

  const updates: {
    status?: LeadStatus;
    notes?: string | null;
  } = {};

  if (input.status) {
    updates.status = input.status;
  }

  if (typeof input.notes !== "undefined") {
    updates.notes = input.notes;
  }

  const { error } = await supabaseAdmin
    .from("leads")
    .update(updates)
    .eq("id", input.id);

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

  const { error } = await supabaseAdmin.from("webhook_events").insert({
    source: input.source,
    payload: input.payload,
    response_status: input.responseStatus,
    response_body: input.responseBody ?? null,
    error: input.error ?? null,
  });

  if (error) {
    console.error("Failed to log webhook event", error);
  }
}
