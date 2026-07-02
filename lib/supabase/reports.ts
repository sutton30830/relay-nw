import { isPlaceholderSupabaseConfig, supabaseAdmin, throwIfSupabaseError } from "./client";
import { assertAccountId } from "./tenant";

export type RecoveryStats = {
  missedCalls: number;
  textedBack: number;
  urgent: number;
  replies: number;
  booked: number;
  recoveredCents: number;
};

export const EMPTY_RECOVERY_STATS: RecoveryStats = {
  missedCalls: 0,
  textedBack: 0,
  urgent: 0,
  replies: 0,
  booked: 0,
  recoveredCents: 0,
};

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

  const missedCalls = await countLeadsWhere(accountId, since, until, (query) =>
    query.eq("source", "missed_call"));

  const textedBack = await countLeadsWhere(accountId, since, until, (query) =>
    query.in("sms_status", ["sent", "delivered"]));

  const urgent = await countLeadsWhere(accountId, since, until, (query) =>
    query.eq("priority", "fast"));

  let repliesQuery = supabaseAdmin
    .from("inbound_messages")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId);
  if (since) repliesQuery = repliesQuery.gte("created_at", since);
  if (until) repliesQuery = repliesQuery.lt("created_at", until);
  const { count: replies, error: repliesError } = await repliesQuery;
  throwIfSupabaseError(repliesError);

  // Booked jobs are attributed to when they were booked, not when the call came in.
  let bookedQuery = supabaseAdmin
    .from("leads")
    .select("id, job_value_cents")
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .not("booked_at", "is", null);
  if (since) bookedQuery = bookedQuery.gte("booked_at", since);
  if (until) bookedQuery = bookedQuery.lt("booked_at", until);
  const { data: bookedRows, error: bookedError } = await bookedQuery.limit(2000);
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
  };
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
