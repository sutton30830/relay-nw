import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";
import { assertAccountId } from "./tenant";
import type { VoicemailTranscriptionStatus } from "./types";

export async function recordingBelongsToLead(recordingSid: string, inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "recordingBelongsToLead");

  if (isPlaceholderSupabaseConfig()) {
    return false;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id")
    .eq("recording_sid", recordingSid)
    .eq("account_id", accountId)
    .limit(1)
    .maybeSingle();

  throwIfSupabaseError(error);

  return Boolean(data?.id);
}

export async function getLeadRecordingForPlayback(recordingSid: string, inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "getLeadRecordingForPlayback");

  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id, recording_url")
    .eq("recording_sid", recordingSid)
    .eq("account_id", accountId)
    .limit(1)
    .maybeSingle();

  throwIfSupabaseError(error);

  return data as { id: string; recording_url: string | null } | null;
}

export async function getLeadForVoicemailTranscription(id: string, inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "getLeadForVoicemailTranscription");

  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id, phone, recording_sid, recording_duration, voicemail_transcript, voicemail_summary, voicemail_transcription_status, voicemail_transcribed_at")
    .eq("id", id)
    .eq("account_id", accountId)
    .maybeSingle();

  throwIfSupabaseError(error);

  return data as {
    id: string;
    phone: string | null;
    recording_sid: string | null;
    recording_duration: number | null;
    voicemail_transcript: string | null;
    voicemail_summary: string | null;
    voicemail_transcription_status: VoicemailTranscriptionStatus;
    voicemail_transcribed_at: string | null;
  } | null;
}

export async function updateLeadVoicemailTranscription(input: {
  accountId: string;
  id: string;
  rawTranscript?: string | null;
  transcript?: string | null;
  summary?: string | null;
  status: VoicemailTranscriptionStatus;
  error?: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "updateLeadVoicemailTranscription");

  if (shouldSkipDatabaseWrite("voicemail transcription update", input)) {
    return;
  }

  const updates: {
    voicemail_raw_transcript?: string | null;
    voicemail_transcript?: string | null;
    voicemail_summary?: string | null;
    voicemail_transcription_status: VoicemailTranscriptionStatus;
    voicemail_transcription_error: string | null;
    voicemail_transcribed_at: string | null;
  } = {
    voicemail_transcription_status: input.status,
    voicemail_transcription_error: input.error ?? null,
    // "completed" records the finish time; "processing" records the start time so a
    // crashed run can be detected as stale and retried instead of locking the lead forever.
    voicemail_transcribed_at:
      input.status === "completed" || input.status === "processing"
        ? new Date().toISOString()
        : null,
  };

  if (typeof input.rawTranscript !== "undefined") {
    updates.voicemail_raw_transcript = input.rawTranscript;
  }

  if (typeof input.transcript !== "undefined") {
    updates.voicemail_transcript = input.transcript;
  }

  if (typeof input.summary !== "undefined") {
    updates.voicemail_summary = input.summary;
  }

  const { error } = await supabaseAdmin
    .from("leads")
    .update(updates)
    .eq("id", input.id)
    .eq("account_id", accountId);

  throwIfSupabaseError(error);
}

// Atomically claims a lead for transcription. Returns true only for the single
// caller that flipped the row into "processing"; every concurrent caller gets
// false. A lead is claimable when it is not currently processing, or its
// processing claim is stale (older than staleBefore).
export async function claimVoicemailTranscription(input: {
  accountId: string;
  id: string;
  staleBefore: string;
}) {
  const accountId = assertAccountId(input.accountId, "claimVoicemailTranscription");

  if (shouldSkipDatabaseWrite("voicemail transcription claim", input)) {
    return true;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .update({
      voicemail_transcription_status: "processing",
      voicemail_transcription_error: null,
      voicemail_transcribed_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .eq("account_id", accountId)
    .or(
      `voicemail_transcription_status.is.null,` +
        `voicemail_transcription_status.in.(pending,failed),` +
        `and(voicemail_transcription_status.eq.processing,voicemail_transcribed_at.lt.${input.staleBefore})`,
    )
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(error);

  return Boolean(data?.id);
}

export async function listLeadsNeedingTranscriptionRetry(limit = 10) {
  // Cross-tenant by design: this is an operator cron, and transcribeLeadVoicemail
  // re-scopes every write by the account_id returned here.
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const createdSince = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id, account_id, voicemail_transcription_status, voicemail_transcribed_at")
    .not("recording_sid", "is", null)
    .or("recording_duration.is.null,recording_duration.gte.3")
    .not("voicemail_transcription_error", "ilike", "Twilio recording download failed with 404%")
    .is("deleted_at", null)
    .or(
      `voicemail_transcription_status.in.(pending,failed),` +
        `and(voicemail_transcription_status.eq.processing,voicemail_transcribed_at.lt.${staleBefore})`,
    )
    .gte("created_at", createdSince)
    .order("created_at", { ascending: true })
    .limit(limit);

  throwIfSupabaseError(error);

  return (data ?? []) as Array<{ id: string; account_id: string }>;
}

export async function updateLeadRecordingByCallSid(input: {
  accountId: string;
  callSid: string;
  callerPhone?: string | null;
  recordingSid?: string | null;
  recordingUrl?: string | null;
  recordingDuration?: number | null;
  recordingStatus?: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "updateLeadRecordingByCallSid");

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
    .eq("account_id", accountId)
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
    .eq("account_id", accountId)
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
    .eq("account_id", accountId)
    .select("id")
    .maybeSingle();

  throwIfSupabaseError(fallbackError);

  return {
    updated: Boolean(fallbackData?.id),
    leadId: fallbackData?.id ?? null,
    matchedBy: fallbackData?.id ? "phone" : null,
  };
}
