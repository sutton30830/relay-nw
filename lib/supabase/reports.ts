import { median } from "@/lib/report-metrics";
import { isPlaceholderSupabaseConfig, supabaseAdmin, throwIfSupabaseError } from "./client";
import { assertAccountId } from "./tenant";

export type RecoveryStats = {
  missedCalls: number;
  textedBack: number;
  urgent: number;
  replies: number;
  booked: number;
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
  booked: 0,
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

  let repliesQuery = supabaseAdmin
    .from("inbound_messages")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);
  if (since) repliesQuery = repliesQuery.gte("created_at", since);
  if (until) repliesQuery = repliesQuery.lt("created_at", until);

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
    { count: replies, error: repliesError },
    { data: bookedRows, error: bookedError },
  ] = await Promise.all([
    countLeadsWhere(accountId, since, until, (query) => query.eq("source", "missed_call")),
    countLeadsWhere(accountId, since, until, (query) => query.in("sms_status", ["sent", "delivered"])),
    countLeadsWhere(accountId, since, until, (query) => query.in("sms_status", ["failed", "undelivered"])),
    countLeadsWhere(accountId, since, until, (query) => query.eq("priority", "fast")),
    repliesQuery,
    bookedQuery.limit(2000),
  ]);

  throwIfSupabaseError(repliesError);
  throwIfSupabaseError(bookedError);

  const booked = bookedRows?.length ?? 0;
  const recoveredCents = (bookedRows ?? []).reduce(
    (total, row) => total + (row.job_value_cents ?? 0),
    0,
  );

  return {
    missedCalls,
    textedBack,
    urgent,
    replies: replies ?? 0,
    booked,
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
