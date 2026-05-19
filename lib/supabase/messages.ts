import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";
import type { SmsStatus } from "./types";

export async function updateLeadSmsStatus(input: {
  accountId?: string | null;
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
    .eq("id", input.id)
    .match(input.accountId ? { account_id: input.accountId } : {});

  throwIfSupabaseError(error);
}

export async function updateLeadSmsStatusByMessageSid(input: {
  accountId?: string | null;
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
    .match(input.accountId ? { account_id: input.accountId } : {})
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(error);

  return { updated: Boolean(data?.id), leadId: data?.id ?? null };
}

export async function hasRecentMissedCallSms(
  phone: string,
  since: Date,
  excludeLeadId?: string,
  accountId?: string | null,
) {
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

  if (accountId) {
    query = query.eq("account_id", accountId);
  }

  if (excludeLeadId) {
    query = query.neq("id", excludeLeadId);
  }

  const { data, error } = await query.limit(1);

  throwIfSupabaseError(error);

  return Boolean(data?.length);
}

export async function isOptedOut(phone: string, accountId?: string | null) {
  if (isPlaceholderSupabaseConfig()) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from("opt_outs")
    .select("phone")
    .eq("phone", phone)
    .match(accountId ? { account_id: accountId } : {})
    .maybeSingle();

  throwIfSupabaseError(error);

  return Boolean(data);
}

export async function recordOptOut(phone: string, accountId?: string | null) {
  if (shouldSkipDatabaseWrite("opt-out insert", { phone, accountId })) {
    return;
  }

  const query = accountId
    ? supabaseAdmin
        .from("opt_outs")
        .upsert({ phone, account_id: accountId }, { onConflict: "account_id,phone" })
    : supabaseAdmin
        .from("opt_outs")
        .insert({ phone, account_id: null });

  const { error } = await query;

  if (error && error.code !== "23505") {
    throw error;
  }
}

export async function createInboundMessageIfNew(input: {
  accountId?: string | null;
  messageSid: string;
  fromPhone: string;
  toPhone?: string | null;
  body: string;
}) {
  if (shouldSkipDatabaseWrite("inbound message insert", input)) {
    return { inserted: true };
  }

  const { error } = await supabaseAdmin.from("inbound_messages").insert({
    account_id: input.accountId ?? null,
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

export async function createMessageIfNew(input: {
  accountId: string | null;
  leadId?: string | null;
  callId?: string | null;
  twilioMessageSid?: string | null;
  direction: "inbound" | "outbound";
  fromPhone?: string | null;
  toPhone?: string | null;
  body?: string | null;
  status?: string | null;
  error?: string | null;
}) {
  if (!input.accountId || shouldSkipDatabaseWrite("message insert", input)) {
    return { inserted: true };
  }

  const { error } = await supabaseAdmin.from("messages").insert({
    account_id: input.accountId,
    lead_id: input.leadId ?? null,
    call_id: input.callId ?? null,
    twilio_message_sid: input.twilioMessageSid ?? null,
    direction: input.direction,
    from_phone: input.fromPhone ?? null,
    to_phone: input.toPhone ?? null,
    body: input.body ?? null,
    status: input.status ?? null,
    error: input.error ?? null,
  });

  if (error) {
    if (error.code === "23505") {
      return { inserted: false };
    }

    throw error;
  }

  return { inserted: true };
}

export async function updateMessageStatusBySid(input: {
  accountId?: string | null;
  twilioMessageSid: string;
  status: string;
  error?: string | null;
}) {
  if (!input.accountId || shouldSkipDatabaseWrite("message status update", input)) {
    return { updated: false };
  }

  const { data, error } = await supabaseAdmin
    .from("messages")
    .update({
      status: input.status,
      error: input.error ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("account_id", input.accountId)
    .eq("twilio_message_sid", input.twilioMessageSid)
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(error);

  return { updated: Boolean(data?.id) };
}
