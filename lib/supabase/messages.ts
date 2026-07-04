import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";
import { assertAccountId } from "./tenant";
import type { SmsStatus } from "./types";

export async function getOutboundMessageLeadIdBySid(input: {
  accountId: string;
  twilioMessageSid: string;
}) {
  const accountId = assertAccountId(input.accountId, "getOutboundMessageLeadIdBySid");

  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("lead_id")
    .eq("account_id", accountId)
    .eq("twilio_message_sid", input.twilioMessageSid)
    .eq("direction", "outbound")
    .maybeSingle();

  throwIfSupabaseError(error);

  return (data?.lead_id as string | null) ?? null;
}

export async function updateLeadSmsStatus(input: {
  accountId: string;
  id: string;
  smsStatus: Exclude<SmsStatus, null>;
  smsError?: string | null;
  twilioMessageSid?: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "updateLeadSmsStatus");

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
    .eq("account_id", accountId);

  throwIfSupabaseError(error);
}

export async function updateLeadSmsStatusByMessageSid(input: {
  accountId: string;
  twilioMessageSid: string;
  smsStatus: Exclude<SmsStatus, null>;
  smsError?: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "updateLeadSmsStatusByMessageSid");

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
    .eq("account_id", accountId)
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(error);

  return { updated: Boolean(data?.id), leadId: data?.id ?? null };
}

export async function hasRecentMissedCallSms(
  phone: string,
  since: Date,
  inputAccountId: string,
  excludeLeadId?: string,
  ownLeadCreatedAt?: string | null,
) {
  const accountId = assertAccountId(inputAccountId, "hasRecentMissedCallSms");

  if (isPlaceholderSupabaseConfig()) {
    return false;
  }

  let query = supabaseAdmin
    .from("leads")
    .select("id, created_at")
    .eq("phone", phone)
    .eq("source", "missed_call")
    .eq("account_id", accountId)
    .in("sms_status", ["pending", "queued", "sending", "sent", "delivered"])
    .gte("created_at", since.toISOString());

  if (excludeLeadId) {
    query = query.neq("id", excludeLeadId);
  }

  const { data, error } = await query.limit(25);

  throwIfSupabaseError(error);

  const competitors = (data ?? []) as Array<{ id: string; created_at: string }>;

  if (competitors.length === 0) {
    return false;
  }

  // Deterministic winner selection for concurrent missed calls from the same caller.
  // Both leads insert with sms_status "pending" before either runs this check, so
  // without a tie-break each would see the other and both would skip — the caller
  // would never be texted. A competing lead only blocks this one if it was created
  // strictly earlier (id as tie-break), so exactly one lead always sends.
  if (excludeLeadId && ownLeadCreatedAt) {
    return competitors.some(
      (competitor) =>
        competitor.created_at < ownLeadCreatedAt ||
        (competitor.created_at === ownLeadCreatedAt && competitor.id < excludeLeadId),
    );
  }

  return true;
}

export async function isOptedOut(phone: string, inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "isOptedOut");

  if (isPlaceholderSupabaseConfig()) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from("opt_outs")
    .select("phone")
    .eq("phone", phone)
    .eq("account_id", accountId)
    .maybeSingle();

  throwIfSupabaseError(error);

  return Boolean(data);
}

export async function recordOptOut(phone: string, inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "recordOptOut");

  if (shouldSkipDatabaseWrite("opt-out insert", { phone, accountId })) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("opt_outs")
    .upsert({ phone, account_id: accountId }, { onConflict: "account_id,phone" });

  if (error && error.code !== "23505") {
    throw error;
  }
}

export async function clearOptOut(phone: string, inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "clearOptOut");

  if (shouldSkipDatabaseWrite("opt-out delete", { phone, accountId })) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("opt_outs")
    .delete()
    .eq("phone", phone)
    .eq("account_id", accountId);

  if (error) {
    throw error;
  }
}

export async function createInboundMessageIfNew(input: {
  accountId: string;
  messageSid: string;
  fromPhone: string;
  toPhone?: string | null;
  body: string;
}) {
  const accountId = assertAccountId(input.accountId, "createInboundMessageIfNew");

  if (shouldSkipDatabaseWrite("inbound message insert", input)) {
    return { inserted: true };
  }

  const { error } = await supabaseAdmin.from("inbound_messages").insert({
    account_id: accountId,
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
  accountId: string;
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
  const accountId = assertAccountId(input.accountId, "createMessageIfNew");

  if (shouldSkipDatabaseWrite("message insert", input)) {
    return { inserted: true };
  }

  const { error } = await supabaseAdmin.from("messages").insert({
    account_id: accountId,
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
  accountId: string;
  twilioMessageSid: string;
  status: string;
  error?: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "updateMessageStatusBySid");

  if (shouldSkipDatabaseWrite("message status update", input)) {
    return { updated: false };
  }

  const { data, error } = await supabaseAdmin
    .from("messages")
    .update({
      status: input.status,
      error: input.error ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("account_id", accountId)
    .eq("twilio_message_sid", input.twilioMessageSid)
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(error);

  return { updated: Boolean(data?.id) };
}
