import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";
import type { Lead, LeadSource, LeadStatus, ReplyPriorityOverride } from "./types";

const LEAD_SELECT_COLUMNS =
  "id, call_sid, name, phone, message, notes, booked_at, job_value_cents, reply_priority_override, source, status, sms_status, sms_error, twilio_message_sid, sms_updated_at, recording_sid, recording_url, recording_duration, recording_status, voicemail_transcript, voicemail_summary, voicemail_transcription_status, voicemail_transcription_error, voicemail_transcribed_at, deleted_at, created_at";
const LEGACY_LEAD_SELECT_COLUMNS =
  "id, call_sid, name, phone, message, notes, job_value_cents, reply_priority_override, source, status, sms_status, sms_error, twilio_message_sid, sms_updated_at, recording_sid, recording_url, recording_duration, recording_status, created_at";

function isMissingBookedAtColumnError(error: { message: string } | null) {
  return Boolean(error?.message.includes("booked_at"));
}

function isMissingOptionalLeadColumnError(error: { message: string } | null) {
  return Boolean(
    error?.message.includes("booked_at") ||
      error?.message.includes("voicemail_transcript") ||
      error?.message.includes("voicemail_summary") ||
      error?.message.includes("voicemail_transcription_status") ||
      error?.message.includes("voicemail_transcription_error") ||
      error?.message.includes("voicemail_transcribed_at") ||
      error?.message.includes("deleted_at") ||
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
    deleted_at: lead.deleted_at ?? null,
    reply_priority_override: lead.reply_priority_override ?? null,
  };

  if (normalizedLead.status !== "booked") {
    return normalizedLead;
  }

  // Legacy migration: "booked" was retired as a status, so old rows are shown as closed with booked_at set.
  return {
    ...normalizedLead,
    booked_at: normalizedLead.booked_at ?? normalizedLead.created_at,
    status: "dead",
  };
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

    return (legacyData ?? []).map((lead) =>
      normalizeLead({
        ...lead,
        booked_at: lead.status === "booked" ? lead.created_at : null,
        deleted_at: null,
      } as Lead),
    );
  }

  throwIfSupabaseError(error);

  return ((data ?? []) as Lead[]).map(normalizeLead);
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
  deletedAt?: string | null;
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
    deleted_at?: string | null;
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

  if (typeof input.deletedAt !== "undefined") {
    updates.deleted_at = input.deletedAt;
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

  throwIfSupabaseError(error);
}

export async function deleteLead(id: string) {
  if (shouldSkipDatabaseWrite("lead delete", { id })) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("leads")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);

  throwIfSupabaseError(error);
}
