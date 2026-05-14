import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";
import type { VoicemailTranscriptionStatus } from "./types";

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

export async function getLeadRecordingForPlayback(recordingSid: string) {
  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id, recording_url")
    .eq("recording_sid", recordingSid)
    .limit(1)
    .maybeSingle();

  throwIfSupabaseError(error);

  return data as { id: string; recording_url: string | null } | null;
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
