import { isPlaceholderSupabaseConfig, supabaseAdmin, throwIfSupabaseError } from "./client";
import { assertAccountId } from "./tenant";

export type RecoveryStats = {
  missedCalls: number; textedBack: number; urgent: number; replies: number;
  uniqueReplyLeads: number; unlinkedReplyCount: number; booked: number;
  bookedMissingValue: number; recoveredCents: number; smsFailed: number;
  knownContactSkipped: number; preSendBlocked: number;
};
export const EMPTY_RECOVERY_STATS: RecoveryStats = {
  missedCalls: 0, textedBack: 0, urgent: 0, replies: 0, uniqueReplyLeads: 0,
  unlinkedReplyCount: 0, booked: 0, bookedMissingValue: 0, recoveredCents: 0,
  smsFailed: 0, knownContactSkipped: 0, preSendBlocked: 0,
};
export type ResponseStats = { medianSeconds: number | null; sampleSize: number };
export const EMPTY_RESPONSE_STATS: ResponseStats = { medianSeconds: null, sampleSize: 0 };

// SQL owns the shared account/Personal/Trash predicate and aggregates all rows,
// including sender-based inbound replies with no verified lead link.
async function businessStats<T>(rpcName: string, inputAccountId: string, period: { since: string | null; until?: string | null }): Promise<T> {
  const accountId = assertAccountId(inputAccountId, rpcName);
  if (isPlaceholderSupabaseConfig()) throw new Error("Business reporting is unavailable");
  const { data, error } = await supabaseAdmin.rpc(rpcName, {
    p_account: accountId, p_since: period.since, p_until: period.until ?? null,
  });
  throwIfSupabaseError(error);
  if (!data || typeof data !== "object") throw new Error("Business reporting is unavailable");
  return data as T;
}
export async function getAccountRecoveryStats(accountId: string, period: { since: string | null; until?: string | null }): Promise<RecoveryStats> {
  const stats = await businessStats<RecoveryStats>("account_business_recovery_stats", accountId, period);
  for (const key of Object.keys(EMPTY_RECOVERY_STATS) as Array<keyof RecoveryStats>) {
    if (typeof stats[key] !== "number" || !Number.isFinite(stats[key])) throw new Error("Business reporting is unavailable");
  }
  return stats;
}
export async function getAccountResponseStats(accountId: string, period: { since: string | null; until?: string | null }): Promise<ResponseStats> {
  const stats = await businessStats<ResponseStats>("account_business_response_stats", accountId, period);
  if (!Number.isFinite(stats.sampleSize) || (stats.medianSeconds !== null && !Number.isFinite(stats.medianSeconds))) throw new Error("Response reporting is unavailable");
  return stats;
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
