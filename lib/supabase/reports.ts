import { median } from "@/lib/report-metrics";
import { isPlaceholderSupabaseConfig, supabaseAdmin, throwIfSupabaseError } from "./client";
import { assertAccountId } from "./tenant";

export type RecoveryStats = {
  missedCalls: number;
  textedBack: number;
  urgent: number;
  replies: number;
  uniqueReplyLeads: number;
  booked: number;
  bookedMissingValue: number;
  recoveredCents: number;
  // Auto-texts that failed to reach the caller (failed/undelivered). Paired with
  // textedBack this gives a text success rate.
  smsFailed: number;
};

export const EMPTY_RECOVERY_STATS: RecoveryStats = {
  missedCalls: 0,
  textedBack: 0,
  urgent: 0,
  replies: 0,
  uniqueReplyLeads: 0,
  booked: 0,
  bookedMissingValue: 0,
  recoveredCents: 0,
  smsFailed: 0,
};

export type ResponseStats = {
  // Median seconds from a missed call to the caller's first outbound message
  // (usually the instant auto-text; slower when it's a manual follow-up).
  medianSeconds: number | null;
  sampleSize: number;
};

export const EMPTY_RESPONSE_STATS: ResponseStats = { medianSeconds: null, sampleSize: 0 };

type SupabaseReportError = { message: string; code?: string } | null;

function isMissingReplyLeadIdError(error: SupabaseReportError) {
  if (!error) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("lead_id") &&
    (error.code === "42703" ||
      error.code === "PGRST204" ||
      message.includes("column") ||
      message.includes("schema cache"))
  );
}

async function getReplyStats(accountId: string, since: string | null, until: string | null) {
  let richQuery = supabaseAdmin
    .from("inbound_messages")
    .select("id, lead_id")
    .eq("account_id", accountId);
  if (since) richQuery = richQuery.gte("created_at", since);
  if (until) richQuery = richQuery.lt("created_at", until);

  const { data, error } = await richQuery.limit(5000);

  if (!error) {
    return {
      replies: data?.length ?? 0,
      uniqueReplyLeads: new Set(
        (data ?? []).map((row) => row.lead_id as string | null).filter(Boolean),
      ).size,
    };
  }

  if (!isMissingReplyLeadIdError(error)) {
    throwIfSupabaseError(error);
  }

  console.warn("inbound_messages.lead_id is unavailable. Reports are falling back to raw reply count.");

  let fallbackQuery = supabaseAdmin
    .from("inbound_messages")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);
  if (since) fallbackQuery = fallbackQuery.gte("created_at", since);
  if (until) fallbackQuery = fallbackQuery.lt("created_at", until);

  const { count, error: fallbackError } = await fallbackQuery;
  throwIfSupabaseError(fallbackError);

  const replies = count ?? 0;
  return {
    replies,
    // Compatibility fallback: if the richer lead_id column is not deployed yet,
    // avoid taking the Reports page down. This may over-count when one lead
    // sends multiple replies, but it keeps the owner-facing page available.
    uniqueReplyLeads: replies,
  };
}

async function countLeadsWhere(
  accountId: string,
  since: string | null,
  until: string | null,
  refine: (query: ReturnType<typeof buildLeadCountQuery>) => ReturnType<typeof buildLeadCountQuery>,
) {
  let query = buildLeadCountQuery(accountId, since, until);
  query = refine(query);

  const { count, error } = await query;
  throwIfSupabaseError(error);
  return count ?? 0;
}

function buildLeadCountQuery(accountId: string, since: string | null, until: string | null) {
  let query = supabaseAdmin
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .is("deleted_at", null);

  if (since) query = query.gte("created_at", since);
  if (until) query = query.lt("created_at", until);

  return query;
}

export async function getAccountRecoveryStats(
  inputAccountId: string,
  period: { since: string | null; until?: string | null },
): Promise<RecoveryStats> {
  const accountId = assertAccountId(inputAccountId, "getAccountRecoveryStats");

  if (isPlaceholderSupabaseConfig()) {
    return EMPTY_RECOVERY_STATS;
  }

  const since = period.since;
  const until = period.until ?? null;

  // Booked jobs are attributed to when they were booked, not when the call came in.
  let bookedQuery = supabaseAdmin
    .from("leads")
    .select("id, job_value_cents")
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .not("booked_at", "is", null);
  if (since) bookedQuery = bookedQuery.gte("booked_at", since);
  if (until) bookedQuery = bookedQuery.lt("booked_at", until);

  const [
    missedCalls,
    textedBack,
    smsFailed,
    urgent,
    replyStats,
    { data: bookedRows, error: bookedError },
  ] = await Promise.all([
    countLeadsWhere(accountId, since, until, (query) => query.eq("source", "missed_call")),
    countLeadsWhere(accountId, since, until, (query) => query.in("sms_status", ["sent", "delivered"])),
    countLeadsWhere(accountId, since, until, (query) => query.in("sms_status", ["failed", "undelivered"])),
    countLeadsWhere(accountId, since, until, (query) => query.eq("priority", "fast")),
    getReplyStats(accountId, since, until),
    bookedQuery.limit(2000),
  ]);

  throwIfSupabaseError(bookedError);

  const booked = bookedRows?.length ?? 0;
  const bookedMissingValue = (bookedRows ?? []).filter((row) => (row.job_value_cents ?? 0) <= 0).length;
  const recoveredCents = (bookedRows ?? []).reduce(
    (total, row) => total + (row.job_value_cents ?? 0),
    0,
  );

  return {
    missedCalls,
    textedBack,
    urgent,
    replies: replyStats.replies,
    uniqueReplyLeads: replyStats.uniqueReplyLeads,
    booked,
    bookedMissingValue,
    recoveredCents,
    smsFailed,
  };
}

// Median time from a missed call to the caller's first outbound message. Bounded
// per period so it stays cheap; the auto-text makes this near-instant when SMS
// is on, and reflects manual follow-up speed when it isn't.
export async function getAccountResponseStats(
  inputAccountId: string,
  period: { since: string | null; until?: string | null },
): Promise<ResponseStats> {
  const accountId = assertAccountId(inputAccountId, "getAccountResponseStats");

  if (isPlaceholderSupabaseConfig()) {
    return EMPTY_RESPONSE_STATS;
  }

  const since = period.since;
  const until = period.until ?? null;

  let leadsQuery = supabaseAdmin
    .from("leads")
    .select("id, created_at")
    .eq("account_id", accountId)
    .eq("source", "missed_call")
    .is("deleted_at", null);
  if (since) leadsQuery = leadsQuery.gte("created_at", since);
  if (until) leadsQuery = leadsQuery.lt("created_at", until);

  const { data: leads, error: leadsError } = await leadsQuery.limit(2000);
  throwIfSupabaseError(leadsError);

  if (!leads || leads.length === 0) {
    return EMPTY_RESPONSE_STATS;
  }

  const leadIds = leads.map((row) => row.id as string);
  const { data: outbound, error: outboundError } = await supabaseAdmin
    .from("messages")
    .select("lead_id, created_at")
    .eq("account_id", accountId)
    .eq("direction", "outbound")
    .in("lead_id", leadIds)
    .order("created_at", { ascending: true })
    .limit(5000);
  throwIfSupabaseError(outboundError);

  // First (earliest) outbound message per lead — the query is time-ascending, so
  // the first one seen wins.
  const firstOutboundByLead = new Map<string, string>();
  for (const message of outbound ?? []) {
    const leadId = message.lead_id as string | null;
    if (leadId && !firstOutboundByLead.has(leadId)) {
      firstOutboundByLead.set(leadId, message.created_at as string);
    }
  }

  const deltas: number[] = [];
  for (const lead of leads) {
    const firstOutbound = firstOutboundByLead.get(lead.id as string);
    if (!firstOutbound) continue;
    const seconds =
      (new Date(firstOutbound).getTime() - new Date(lead.created_at as string).getTime()) / 1000;
    if (Number.isFinite(seconds) && seconds >= 0) deltas.push(seconds);
  }

  return { medianSeconds: median(deltas), sampleSize: deltas.length };
}

// When did Relay last catch a real missed call — the strongest, freshest proof
// the pipeline works end to end. Null if it never has.
export async function getLastRecoveredCallAt(inputAccountId: string): Promise<string | null> {
  const accountId = assertAccountId(inputAccountId, "getLastRecoveredCallAt");

  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("leads")
    .select("created_at")
    .eq("account_id", accountId)
    .eq("source", "missed_call")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("Could not load last recovered call time.", { accountId, error: error.message });
    return null;
  }

  return (data?.created_at as string | undefined) ?? null;
}

// Durable proof that a valid Twilio-signed missed call moved this account live.
// Unlike a generic missed-call lead, this audit action is written only by the
// protected atomic activation RPC after signature validation succeeds.
export async function getSignedCallVerificationAt(inputAccountId: string): Promise<string | null> {
  const accountId = assertAccountId(inputAccountId, "getSignedCallVerificationAt");

  if (isPlaceholderSupabaseConfig()) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("account_audit_events")
    .select("created_at")
    .eq("account_id", accountId)
    .eq("action", "onboarding.first_call_live")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("Could not load signed call verification evidence.", {
      accountId,
      error: error.message,
    });
    return null;
  }

  return (data?.created_at as string | undefined) ?? null;
}

export async function listActiveAccountIds() {
  if (isPlaceholderSupabaseConfig()) {
    return [] as string[];
  }

  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("id")
    .eq("status", "active")
    .limit(500);

  throwIfSupabaseError(error);

  return (data ?? []).map((row) => row.id as string);
}
