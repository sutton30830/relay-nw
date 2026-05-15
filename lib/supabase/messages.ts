import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";
import type { SmsStatus } from "./types";

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

export async function hasRecentMissedCallSms(phone: string, since: Date, excludeLeadId?: string) {
  if (isPlaceholderSupabaseConfig()) {
    return false;
  }

  let query = supabaseAdmin
    .from("leads")
    .select("id")
    .eq("phone", phone)
    .eq("source", "missed_call")
    .in("sms_status", ["pending", "queued", "sending", "sent", "delivered"])
    .gte("created_at", since.toISOString());

  if (excludeLeadId) {
    query = query.neq("id", excludeLeadId);
  }

  const { data, error } = await query.limit(1);

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
