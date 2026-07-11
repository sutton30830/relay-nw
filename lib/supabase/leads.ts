import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";
import { assertAccountId } from "./tenant";
import type { InboundMessage, Lead, LeadInboxFilter, LeadSource, LeadStatus, OutboundMessage, ReplyPriorityOverride } from "./types";

const LEAD_SELECT_COLUMNS =
  "id, account_id, call_sid, name, phone, message, notes, booked_at, job_value_cents, reply_priority_override, priority, priority_reason, source, status, sms_status, sms_error, twilio_message_sid, sms_updated_at, recording_sid, recording_url, recording_duration, recording_status, voicemail_transcript, voicemail_summary, voicemail_transcription_status, voicemail_transcription_error, voicemail_transcribed_at, deleted_at, created_at";
const LEGACY_LEAD_SELECT_COLUMNS =
  "id, account_id, call_sid, name, phone, message, notes, job_value_cents, reply_priority_override, source, status, sms_status, sms_error, twilio_message_sid, sms_updated_at, recording_sid, recording_url, recording_duration, recording_status, created_at";

function isMissingBookedAtColumnError(error: { message: string } | null) {
  return Boolean(error?.message.includes("booked_at"));
}

function isMissingSearchRpcError(error: { message: string; code?: string } | null) {
  // 42883: undefined_function (raw Postgres). PGRST202: PostgREST's "could not
  // find function in schema cache" — either way, supabase.sql hasn't been run yet.
  return Boolean(
    error?.code === "42883" ||
      error?.code === "PGRST202" ||
      error?.message.includes("search_lead_inbox") ||
      error?.message.includes("lead_inbox_counts"),
  );
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
      error?.message.includes("reply_priority_override") ||
      error?.message.includes("priority"),
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
    inbound_messages: lead.inbound_messages ?? [],
    outbound_messages: lead.outbound_messages ?? [],
    deleted_at: lead.deleted_at ?? null,
    reply_priority_override: lead.reply_priority_override ?? null,
    priority: lead.priority ?? null,
    priority_reason: lead.priority_reason ?? null,
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

async function attachInboundMessages(leads: Lead[], accountId: string) {
  if (isPlaceholderSupabaseConfig() || leads.length === 0) {
    return leads;
  }

  const phones = [...new Set(leads.map((lead) => lead.phone).filter(Boolean))];
  let query = supabaseAdmin
    .from("inbound_messages")
    .select("id, message_sid, from_phone, to_phone, body, created_at")
    .in("from_phone", phones)
    .order("created_at", { ascending: false })
    .limit(200);

  query = query.eq("account_id", accountId);

  const { data, error } = await query;

  if (error) {
    console.warn("Could not load inbound SMS replies for leads.", { error });
    return leads;
  }

  const messagesByPhone = new Map<string, InboundMessage[]>();

  for (const message of (data ?? []) as InboundMessage[]) {
    const messages = messagesByPhone.get(message.from_phone) ?? [];
    if (messages.length < 5) {
      messages.push(message);
      messagesByPhone.set(message.from_phone, messages);
    }
  }

  return leads.map((lead) => ({
    ...lead,
    inbound_messages: messagesByPhone.get(lead.phone) ?? [],
  }));
}

async function attachOutboundMessages(leads: Lead[], accountId: string) {
  if (isPlaceholderSupabaseConfig() || leads.length === 0) {
    return leads;
  }

  const leadIds = leads.map((lead) => lead.id);
  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("id, lead_id, twilio_message_sid, from_phone, to_phone, body, status, created_at")
    .eq("account_id", accountId)
    .eq("direction", "outbound")
    .in("lead_id", leadIds)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    // Non-fatal: the inbox still renders without the outbound thread.
    console.warn("Could not load outbound messages for leads.", { error });
    return leads;
  }

  const messagesByLeadId = new Map<string, OutboundMessage[]>();

  for (const message of (data ?? []) as OutboundMessage[]) {
    if (!message.lead_id) continue;
    const messages = messagesByLeadId.get(message.lead_id) ?? [];
    if (messages.length < 10) {
      messages.push(message);
      messagesByLeadId.set(message.lead_id, messages);
    }
  }

  return leads.map((lead) => ({
    ...lead,
    outbound_messages: messagesByLeadId.get(lead.id) ?? [],
  }));
}

export type LeadsPageResult = {
  leads: Lead[];
  total: number | null;
  limit: number;
  offset: number;
  // Total call rows per phone across the whole account (the "Called N×" badge).
  // Empty on the legacy fallback path, where the client recomputes it locally.
  callCounts?: Record<string, number>;
};

export const DEFAULT_LEADS_PAGE_LIMIT = 100;
const MAX_LEADS_PAGE_LIMIT = 250;

async function attachThreadMessages(leads: Lead[], accountId: string) {
  const [withInbound, withOutbound] = await Promise.all([
    attachInboundMessages(leads, accountId),
    attachOutboundMessages(leads, accountId),
  ]);

  return leads.map((lead, index) => ({
    ...lead,
    inbound_messages: withInbound[index]?.inbound_messages ?? [],
    outbound_messages: withOutbound[index]?.outbound_messages ?? [],
  }));
}

function normalizePageOptions(options?: { limit?: number; offset?: number }) {
  const rawLimit = Number(options?.limit ?? DEFAULT_LEADS_PAGE_LIMIT);
  const rawOffset = Number(options?.offset ?? 0);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LEADS_PAGE_LIMIT)
    : DEFAULT_LEADS_PAGE_LIMIT;
  const offset = Number.isFinite(rawOffset) ? Math.max(Math.floor(rawOffset), 0) : 0;

  return { limit, offset };
}

// Server-side classification result. Warn-only when the columns are missing so a
// deploy ahead of the SQL migration degrades gracefully instead of failing webhooks.
export async function updateLeadPriority(input: {
  accountId: string;
  id: string;
  priority: "fast" | "today" | "normal";
  priorityReason: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "updateLeadPriority");

  if (shouldSkipDatabaseWrite("lead priority update", input)) {
    return;
  }

  const { error } = await supabaseAdmin
    .from("leads")
    .update({ priority: input.priority, priority_reason: input.priorityReason })
    .eq("account_id", accountId)
    .eq("id", input.id);

  if (error) {
    if (error.message.includes("priority")) {
      console.warn("leads.priority columns are missing. Run supabase.sql to enable persisted urgency.", {
        leadId: input.id,
      });
      return;
    }

    throw error;
  }
}

export async function getLeadByIdForAccount(inputAccountId: string, id: string) {
  const accountId = assertAccountId(inputAccountId, "getLeadByIdForAccount");

  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("id, phone, status, deleted_at")
    .eq("account_id", accountId)
    .eq("id", id)
    .maybeSingle();

  throwIfSupabaseError(error);

  return (data ?? null) as Pick<Lead, "id" | "phone" | "status" | "deleted_at"> | null;
}

export async function createLead(input: {
  accountId: string;
  name?: string | null;
  phone: string;
  message?: string | null;
  source: LeadSource;
  callSid?: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "createLead");

  if (shouldSkipDatabaseWrite("lead insert", input)) {
    return;
  }

  const { error } = await supabaseAdmin.from("leads").insert({
    account_id: accountId,
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
  accountId: string;
  callSid: string;
  phone: string;
  message: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "createMissedCallLeadIfNew");

  if (shouldSkipDatabaseWrite("missed call lead insert", input)) {
    return { inserted: true, leadId: null, createdAt: null };
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .insert({
      account_id: accountId,
      call_sid: input.callSid,
      phone: input.phone,
      message: input.message,
      sms_status: "pending",
      source: "missed_call",
      status: "new",
    })
    .select("id, created_at")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return { inserted: false, leadId: null, createdAt: null };
    }

    throw error;
  }

  return {
    inserted: Boolean(data?.id),
    leadId: data?.id ?? null,
    createdAt: (data?.created_at as string | undefined) ?? null,
  };
}

type SearchLeadInboxRow = Omit<Lead, "inbound_messages" | "outbound_messages"> & {
  call_count: number | string;
  total_count: number | string;
};

function rowToLead(row: SearchLeadInboxRow): Lead {
  const { call_count: _callCount, total_count: _totalCount, ...lead } = row;
  return { ...lead, inbound_messages: [], outbound_messages: [] };
}

export type LeadInboxCounts = {
  all: number;
  new: number;
  contacted: number;
  booked: number;
  dead: number;
  trash: number;
  actionable: number;
  smsIssues: number;
  bookedValueCents: number;
  bookedWithValue: number;
};

const EMPTY_LEAD_INBOX_COUNTS: LeadInboxCounts = {
  all: 0,
  new: 0,
  contacted: 0,
  booked: 0,
  dead: 0,
  trash: 0,
  actionable: 0,
  smsIssues: 0,
  bookedValueCents: 0,
  bookedWithValue: 0,
};

// Server-side counterpart to countLeads in app/leads/_utils.ts, computed over
// every lead for the account (not just the loaded page) so filter-pill counts
// stay correct past the first page.
export async function getLeadInboxCountsForAccount(inputAccountId: string): Promise<LeadInboxCounts> {
  const accountId = assertAccountId(inputAccountId, "getLeadInboxCountsForAccount");

  if (isPlaceholderSupabaseConfig()) {
    return EMPTY_LEAD_INBOX_COUNTS;
  }

  const { data, error } = await supabaseAdmin.rpc("lead_inbox_counts", { p_account: accountId }).maybeSingle();

  if (isMissingSearchRpcError(error)) {
    console.warn("lead_inbox_counts is missing. Run supabase.sql to enable server-side lead counts.");
    return EMPTY_LEAD_INBOX_COUNTS;
  }

  throwIfSupabaseError(error);

  if (!data) {
    return EMPTY_LEAD_INBOX_COUNTS;
  }

  const row = data as {
    all_count: number | string;
    new_count: number | string;
    contacted_count: number | string;
    booked_count: number | string;
    dead_count: number | string;
    trash_count: number | string;
    actionable_count: number | string;
    sms_issues_count: number | string;
    booked_value_cents: number | string;
    booked_with_value_count: number | string;
  };

  return {
    all: Number(row.all_count),
    new: Number(row.new_count),
    contacted: Number(row.contacted_count),
    booked: Number(row.booked_count),
    dead: Number(row.dead_count),
    trash: Number(row.trash_count),
    actionable: Number(row.actionable_count),
    smsIssues: Number(row.sms_issues_count),
    bookedValueCents: Number(row.booked_value_cents),
    bookedWithValue: Number(row.booked_with_value_count),
  };
}

export async function getLeadInboxPageForAccount(
  inputAccountId: string,
  options?: { limit?: number; offset?: number; filter?: LeadInboxFilter; query?: string },
): Promise<LeadsPageResult> {
  const accountId = assertAccountId(inputAccountId, "getLeadsForAccount");
  const { limit, offset } = normalizePageOptions(options);
  const filter = options?.filter ?? "all";
  const query = options?.query?.trim() ?? "";

  if (isPlaceholderSupabaseConfig()) {
    return { leads: [] as Lead[], total: 0, limit, offset };
  }

  const { data: rows, error: rpcError } = await supabaseAdmin.rpc("search_lead_inbox", {
    p_account: accountId,
    p_filter: filter,
    p_query: query,
    p_limit: limit,
    p_offset: offset,
  });

  if (!isMissingSearchRpcError(rpcError)) {
    throwIfSupabaseError(rpcError);

    const searchRows = (rows ?? []) as SearchLeadInboxRow[];
    const total = searchRows.length > 0 ? Number(searchRows[0].total_count) : 0;
    const callCounts: Record<string, number> = {};
    for (const row of searchRows) {
      callCounts[row.phone] = Number(row.call_count);
    }
    const leads = await attachThreadMessages(searchRows.map(rowToLead).map(normalizeLead), accountId);

    return { leads, total, limit, offset, callCounts };
  }

  console.warn("search_lead_inbox is missing. Run supabase.sql to enable server-side lead search and filtering.");

  let legacyBaseQuery = supabaseAdmin
    .from("leads")
    .select(LEAD_SELECT_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  legacyBaseQuery = legacyBaseQuery.eq("account_id", accountId);

  const { data, error, count } = await legacyBaseQuery;

  if (isMissingOptionalLeadColumnError(error)) {
    console.warn("Some optional leads columns are missing. Run supabase.sql to enable all inbox features.");

    let legacyQuery = supabaseAdmin
      .from("leads")
      .select(LEGACY_LEAD_SELECT_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    legacyQuery = legacyQuery.eq("account_id", accountId);

    const { data: legacyData, error: legacyError, count: legacyCount } = await legacyQuery;

    throwIfSupabaseError(legacyError);

    const legacyLeads = (legacyData ?? []).map((lead) =>
      normalizeLead({
        ...lead,
        booked_at: lead.status === "booked" ? lead.created_at : null,
        deleted_at: null,
      } as Lead),
    );

    const leads = await attachThreadMessages(legacyLeads, accountId);
    return { leads, total: legacyCount ?? null, limit, offset };
  }

  throwIfSupabaseError(error);

  const leads = await attachThreadMessages(((data ?? []) as Lead[]).map(normalizeLead), accountId);
  return {
    leads,
    total: count ?? null,
    limit,
    offset,
  };
}

export async function getLeadsForAccount(inputAccountId: string) {
  return (await getLeadInboxPageForAccount(inputAccountId)).leads;
}

export async function updateLead(input: {
  accountId: string;
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
  const accountId = assertAccountId(input.accountId, "updateLead");

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

  // Trash/restore applies to the whole caller, not a single row. The inbox
  // shows one card per phone; leaving sibling rows behind would fragment the
  // caller across Trash and the live inbox.
  if (typeof input.deletedAt !== "undefined") {
    const { data: lead, error: leadError } = await supabaseAdmin
      .from("leads")
      .select("phone")
      .eq("id", input.id)
      .eq("account_id", accountId)
      .maybeSingle();

    throwIfSupabaseError(leadError);

    if (lead?.phone) {
      const { error: deletedError } = await supabaseAdmin
        .from("leads")
        .update({ deleted_at: input.deletedAt })
        .eq("phone", lead.phone)
        .eq("account_id", accountId);

      throwIfSupabaseError(deletedError);
    } else {
      updates.deleted_at = input.deletedAt;
    }
  }

  if (typeof input.name !== "undefined") {
    const { data: lead, error: leadError } = await supabaseAdmin
      .from("leads")
      .select("phone")
      .eq("id", input.id)
      .eq("account_id", accountId)
      .maybeSingle();

    throwIfSupabaseError(leadError);

    if (lead?.phone) {
      const { error: nameError } = await supabaseAdmin
        .from("leads")
        .update({ name: input.name })
        .eq("phone", lead.phone)
        .eq("account_id", accountId);

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
    .eq("id", input.id)
    .eq("account_id", accountId);

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
      .eq("id", input.id)
      .eq("account_id", accountId);

    throwIfSupabaseError(legacyError);
    return;
  }

  throwIfSupabaseError(error);
}

// Soft-deletes the caller's entire thread. The inbox condenses rows by phone
// into one card, so trashing only the newest row would immediately surface the
// next-newest row as a live card — delete would look like it didn't work.
export async function deleteLead(id: string, inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "deleteLead");

  if (shouldSkipDatabaseWrite("lead delete", { id, accountId })) {
    return;
  }

  const { data: lead, error: leadError } = await supabaseAdmin
    .from("leads")
    .select("phone")
    .eq("id", id)
    .eq("account_id", accountId)
    .maybeSingle();

  throwIfSupabaseError(leadError);

  let query = supabaseAdmin
    .from("leads")
    .update({ deleted_at: new Date().toISOString() })
    .eq("account_id", accountId);

  query = lead?.phone ? query.eq("phone", lead.phone) : query.eq("id", id);

  const { error } = await query;

  throwIfSupabaseError(error);
}

export type LeadConversation = {
  lead: Lead;
  previousLeads: Lead[];
  inbound: InboundMessage[];
  outbound: OutboundMessage[];
};

// Full history for the conversation page: the lead, every earlier lead from the
// same number (each one is a call event), and ALL SMS in both directions keyed
// by phone — unlike the inbox attach helpers, nothing is capped per lead.
export async function getLeadConversation(inputAccountId: string, id: string): Promise<LeadConversation | null> {
  const accountId = assertAccountId(inputAccountId, "getLeadConversation");

  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select(LEAD_SELECT_COLUMNS)
    .eq("account_id", accountId)
    .eq("id", id)
    .maybeSingle();

  throwIfSupabaseError(error);

  if (!data) {
    return null;
  }

  const lead = normalizeLead(data as unknown as Lead);

  const [siblings, inboundResult, outboundResult] = await Promise.all([
    supabaseAdmin
      .from("leads")
      .select(LEAD_SELECT_COLUMNS)
      .eq("account_id", accountId)
      .eq("phone", lead.phone)
      .neq("id", lead.id)
      // Deleted rows stay in the thread: they're calls that really happened,
      // and the card's "N calls" count includes them.
      .order("created_at", { ascending: false })
      .limit(50),
    supabaseAdmin
      .from("inbound_messages")
      .select("id, message_sid, from_phone, to_phone, body, created_at")
      .eq("account_id", accountId)
      .eq("from_phone", lead.phone)
      .order("created_at", { ascending: true })
      .limit(500),
    supabaseAdmin
      .from("messages")
      .select("id, lead_id, twilio_message_sid, from_phone, to_phone, body, status, created_at")
      .eq("account_id", accountId)
      .eq("direction", "outbound")
      .eq("to_phone", lead.phone)
      .order("created_at", { ascending: true })
      .limit(500),
  ]);

  // Message history is non-fatal: the page still renders the lead and calls.
  if (siblings.error) console.warn("Could not load earlier calls for conversation.", { error: siblings.error });
  if (inboundResult.error) console.warn("Could not load inbound SMS for conversation.", { error: inboundResult.error });
  if (outboundResult.error) console.warn("Could not load outbound SMS for conversation.", { error: outboundResult.error });

  return {
    lead,
    previousLeads: ((siblings.data ?? []) as unknown as Lead[]).map(normalizeLead),
    inbound: (inboundResult.data ?? []) as InboundMessage[],
    outbound: (outboundResult.data ?? []) as OutboundMessage[],
  };
}
