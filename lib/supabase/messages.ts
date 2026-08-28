import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";
import { assertAccountId } from "./tenant";
import type { SmsStatus } from "./types";

export async function getOutboundMessageLeadIdByProviderId(input: {
  accountId: string;
  providerMessageId?: string;
  /** @deprecated Compatibility alias for legacy callers. */
  twilioMessageSid?: string;
}) {
  const accountId = assertAccountId(input.accountId, "getOutboundMessageLeadIdByProviderId");
  const providerMessageId = (input.providerMessageId ?? input.twilioMessageSid)?.trim();
  if (!providerMessageId) {
    throw new Error("getOutboundMessageLeadIdByProviderId requires a provider message identifier");
  }

  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("lead_id")
    .eq("account_id", accountId)
    .eq("twilio_message_sid", providerMessageId)
    .eq("direction", "outbound")
    .maybeSingle();

  throwIfSupabaseError(error);

  return (data?.lead_id as string | null) ?? null;
}

/** @deprecated Use getOutboundMessageLeadIdByProviderId. */
export const getOutboundMessageLeadIdBySid = getOutboundMessageLeadIdByProviderId;

export async function updateLeadSmsStatus(input: {
  accountId: string;
  id: string;
  smsStatus: Exclude<SmsStatus, null>;
  smsError?: string | null;
  providerMessageId?: string | null;
  /** @deprecated Compatibility alias for legacy callers. */
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

  const providerMessageId = input.providerMessageId ?? input.twilioMessageSid;
  if (typeof providerMessageId !== "undefined") {
    updates.twilio_message_sid = providerMessageId;
  }

  const { error } = await supabaseAdmin
    .from("leads")
    .update(updates)
    .eq("id", input.id)
    .eq("account_id", accountId);

  throwIfSupabaseError(error);
}

export async function updateLeadSmsStatusByProviderMessageId(input: {
  accountId: string;
  providerMessageId?: string;
  /** @deprecated Compatibility alias for legacy callers. */
  twilioMessageSid?: string;
  smsStatus: Exclude<SmsStatus, null>;
  smsError?: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "updateLeadSmsStatusByProviderMessageId");
  const providerMessageId = (input.providerMessageId ?? input.twilioMessageSid)?.trim();
  if (!providerMessageId) {
    throw new Error("updateLeadSmsStatusByProviderMessageId requires a provider message identifier");
  }

  if (shouldSkipDatabaseWrite("SMS status callback update", input)) {
    return { updated: false };
  }

  let query = supabaseAdmin
    .from("leads")
    .update({
      sms_status: input.smsStatus,
      sms_error: input.smsError ?? null,
      sms_updated_at: new Date().toISOString(),
    })
    .eq("twilio_message_sid", providerMessageId)
    .eq("account_id", accountId);

  // Twilio may deliver duplicate callbacks out of order. Once delivery is
  // confirmed, a late "sent" or "failed" callback must not downgrade truth.
  if (input.smsStatus !== "delivered") {
    query = query.neq("sms_status", "delivered");
  }

  const { data, error } = await query
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(error);

  return { updated: Boolean(data?.id), leadId: data?.id ?? null };
}

/** @deprecated Use updateLeadSmsStatusByProviderMessageId. */
export const updateLeadSmsStatusByMessageSid = updateLeadSmsStatusByProviderMessageId;

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
  providerMessageId?: string;
  /** @deprecated Compatibility alias for legacy callers. */
  messageSid?: string;
  fromPhone: string;
  toPhone?: string | null;
  body: string;
}) {
  const accountId = assertAccountId(input.accountId, "createInboundMessageIfNew");
  const providerMessageId = (input.providerMessageId ?? input.messageSid)?.trim();
  if (!providerMessageId) {
    throw new Error("createInboundMessageIfNew requires a provider message identifier");
  }

  if (shouldSkipDatabaseWrite("inbound message insert", input)) {
    return { inserted: true };
  }

  const { error } = await supabaseAdmin.from("inbound_messages").insert({
    account_id: accountId,
    message_sid: providerMessageId,
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
  providerMessageId?: string | null;
  /** @deprecated Compatibility alias for legacy callers. */
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
    twilio_message_sid: input.providerMessageId ?? input.twilioMessageSid ?? null,
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

export async function updateMessageStatusByProviderMessageId(input: {
  accountId: string;
  providerMessageId?: string;
  /** @deprecated Compatibility alias for legacy callers. */
  twilioMessageSid?: string;
  status: string;
  error?: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "updateMessageStatusByProviderMessageId");
  const providerMessageId = (input.providerMessageId ?? input.twilioMessageSid)?.trim();
  if (!providerMessageId) {
    throw new Error("updateMessageStatusByProviderMessageId requires a provider message identifier");
  }

  if (shouldSkipDatabaseWrite("message status update", input)) {
    return { updated: false };
  }

  let query = supabaseAdmin
    .from("messages")
    .update({
      status: input.status,
      error: input.error ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("account_id", accountId)
    .eq("twilio_message_sid", providerMessageId);

  if (input.status !== "delivered") {
    query = query.neq("status", "delivered");
  }

  const { data, error } = await query
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(error);

  return { updated: Boolean(data?.id) };
}

/** @deprecated Use updateMessageStatusByProviderMessageId. */
export const updateMessageStatusBySid = updateMessageStatusByProviderMessageId;
