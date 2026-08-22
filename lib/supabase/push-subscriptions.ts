import { supabaseAdmin } from "./client";
import { assertAccountId } from "./tenant";

export type OwnerPushEvent = "missed_call" | "voicemail_ready";

export type OwnerPushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failureCount: number;
};

export async function upsertOwnerPushSubscription(input: {
  accountId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  missedCallEnabled: boolean;
  voicemailReadyEnabled: boolean;
}) {
  const accountId = assertAccountId(input.accountId, "upsert owner push subscription");
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("owner_push_subscriptions")
    .upsert({
      account_id: accountId,
      user_id: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      user_agent: input.userAgent,
      missed_call_enabled: input.missedCallEnabled,
      voicemail_ready_enabled: input.voicemailReadyEnabled,
      failure_count: 0,
      disabled_at: null,
      updated_at: now,
    }, { onConflict: "endpoint" });

  if (error) throw error;
}

export async function disableOwnerPushSubscription(input: {
  accountId: string;
  userId: string;
  endpoint: string;
}) {
  const accountId = assertAccountId(input.accountId, "disable owner push subscription");
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("owner_push_subscriptions")
    .update({ disabled_at: now, updated_at: now })
    .eq("account_id", accountId)
    .eq("user_id", input.userId)
    .eq("endpoint", input.endpoint);

  if (error) throw error;
}

export async function listActiveOwnerPushSubscriptions(
  accountIdInput: string,
  event: OwnerPushEvent,
): Promise<OwnerPushSubscriptionRow[]> {
  const accountId = assertAccountId(accountIdInput, "list owner push subscriptions");
  const eventColumn = event === "missed_call"
    ? "missed_call_enabled"
    : "voicemail_ready_enabled";
  const { data, error } = await supabaseAdmin
    .from("owner_push_subscriptions")
    .select("id, endpoint, p256dh, auth, failure_count")
    .eq("account_id", accountId)
    .eq(eventColumn, true)
    .is("disabled_at", null);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    endpoint: String(row.endpoint),
    p256dh: String(row.p256dh),
    auth: String(row.auth),
    failureCount: Number(row.failure_count ?? 0),
  }));
}

export async function markOwnerPushSubscriptionSucceeded(input: {
  accountId: string;
  id: string;
}) {
  const accountId = assertAccountId(input.accountId, "mark owner push success");
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("owner_push_subscriptions")
    .update({
      failure_count: 0,
      last_success_at: now,
      updated_at: now,
    })
    .eq("account_id", accountId)
    .eq("id", input.id);

  if (error) throw error;
}

export async function markOwnerPushSubscriptionFailed(input: {
  accountId: string;
  id: string;
  failureCount: number;
  disable: boolean;
}) {
  const accountId = assertAccountId(input.accountId, "mark owner push failure");
  const now = new Date().toISOString();
  const update: {
    failure_count: number;
    updated_at: string;
    disabled_at?: string;
  } = {
    failure_count: Math.max(1, input.failureCount),
    updated_at: now,
  };
  if (input.disable) update.disabled_at = now;

  const { error } = await supabaseAdmin
    .from("owner_push_subscriptions")
    .update(update)
    .eq("account_id", accountId)
    .eq("id", input.id);

  if (error) throw error;
}
