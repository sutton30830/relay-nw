import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";
import { assertAccountId } from "./tenant";

export async function upsertCall(input: {
  accountId: string;
  providerCallId?: string;
  parentProviderCallId?: string | null;
  /** @deprecated Compatibility aliases for legacy callers. */
  callSid?: string;
  parentCallSid?: string | null;
  fromPhone?: string | null;
  toPhone?: string | null;
  status?: string | null;
  dialCallStatus?: string | null;
  rawSummary?: Record<string, unknown>;
}) {
  const accountId = assertAccountId(input.accountId, "upsertCall");
  const providerCallId = (input.providerCallId ?? input.callSid)?.trim();
  if (!providerCallId) throw new Error("upsertCall requires a provider call identifier");

  if (shouldSkipDatabaseWrite("call upsert", input)) {
    return { callId: null };
  }

  const { data, error } = await supabaseAdmin
    .from("calls")
    .upsert({
      account_id: accountId,
      call_sid: providerCallId,
      parent_call_sid: input.parentProviderCallId ?? input.parentCallSid ?? null,
      from_phone: input.fromPhone ?? null,
      to_phone: input.toPhone ?? null,
      status: input.status ?? null,
      dial_call_status: input.dialCallStatus ?? null,
      raw_summary: input.rawSummary ?? {},
      updated_at: new Date().toISOString(),
    }, { onConflict: "account_id,call_sid" })
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(error);

  return { callId: data?.id ?? null };
}

export async function updateCallForMissedLead(input: {
  accountId: string;
  providerCallId?: string;
  /** @deprecated Compatibility alias for legacy callers. */
  callSid?: string;
  leadId: string | null;
  status?: string | null;
  dialCallStatus?: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "updateCallForMissedLead");
  const providerCallId = (input.providerCallId ?? input.callSid)?.trim();
  if (!providerCallId) {
    throw new Error("updateCallForMissedLead requires a provider call identifier");
  }

  if (shouldSkipDatabaseWrite("call missed lead update", input)) {
    return;
  }

  const updates = {
    lead_id: input.leadId,
    status: input.status ?? null,
    dial_call_status: input.dialCallStatus ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabaseAdmin
    .from("calls")
    .update(updates)
    .eq("account_id", accountId)
    .eq("call_sid", providerCallId);

  throwIfSupabaseError(error);
}

export async function updateCallRecordingByProviderCallId(input: {
  accountId: string;
  providerCallId?: string;
  providerRecordingId?: string | null;
  /** @deprecated Compatibility aliases for legacy callers. */
  callSid?: string;
  recordingSid?: string | null;
  recordingUrl?: string | null;
  recordingDuration?: number | null;
  recordingStatus?: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "updateCallRecordingByProviderCallId");
  const providerCallId = (input.providerCallId ?? input.callSid)?.trim();
  if (!providerCallId) {
    throw new Error("updateCallRecordingByProviderCallId requires a provider call identifier");
  }

  if (isPlaceholderSupabaseConfig()) {
    return { updated: false };
  }

  const { data, error } = await supabaseAdmin
    .from("calls")
    .update({
      recording_sid: input.providerRecordingId ?? input.recordingSid ?? null,
      recording_url: input.recordingUrl ?? null,
      recording_duration: input.recordingDuration ?? null,
      recording_status: input.recordingStatus ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("account_id", accountId)
    .eq("call_sid", providerCallId)
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(error);

  return { updated: Boolean(data?.id) };
}

/** @deprecated Use updateCallRecordingByProviderCallId. */
export const updateCallRecordingByCallSid = updateCallRecordingByProviderCallId;
