import { supabaseAdmin, throwIfSupabaseError } from "./client";
import { assertAccountId } from "./tenant";
import type { AccountDeletionPreview, TenantProviderResource } from "@/lib/retention-core";

const ACCOUNT_EXPORT_TABLES = [
  "account_settings",
  "account_carrier_profiles",
  "account_phone_numbers",
  "account_users",
  "account_audit_events",
  "account_onboarding_evidence",
  "leads",
  "calls",
  "messages",
  "inbound_messages",
  "opt_outs",
  "webhook_events",
  "provider_action_events",
] as const;

async function exactCount(table: string, accountId: string) {
  const { count, error } = await supabaseAdmin
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("account_id", accountId);
  throwIfSupabaseError(error);
  return count ?? 0;
}
export async function loadAccountDeletionTarget(inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "loadAccountDeletionTarget");
  const { data, error } = await supabaseAdmin
    .from("accounts")
    .select("id, status, onboarding_status")
    .eq("id", accountId)
    .maybeSingle();
  throwIfSupabaseError(error);
  if (!data) return null;
  return {
    accountId: String(data.id),
    accountStatus: String(data.status),
    technicalStatus: String(data.onboarding_status),
  };
}

export async function wasAccountDeletionCompleted(inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "wasAccountDeletionCompleted");
  const { data, error } = await supabaseAdmin
    .from("data_retention_events")
    .select("id")
    .eq("target_account_id", accountId)
    .eq("action", "account.delete")
    .eq("status", "completed")
    .limit(1)
    .maybeSingle();
  throwIfSupabaseError(error);
  return Boolean(data);
}

export async function previewAccountDeletion(inputAccountId: string): Promise<AccountDeletionPreview> {
  const accountId = assertAccountId(inputAccountId, "previewAccountDeletion");
  const [rows, recordingsResult, messagesResult, greetingObjectsResult] = await Promise.all([
    Promise.all(ACCOUNT_EXPORT_TABLES.map(async (table) => [table, await exactCount(table, accountId)] as const)),
    supabaseAdmin.from("leads").select("recording_sid").eq("account_id", accountId).not("recording_sid", "is", null),
    supabaseAdmin.from("messages").select("twilio_message_sid").eq("account_id", accountId).not("twilio_message_sid", "is", null),
    supabaseAdmin.storage.from("account-greetings").list(accountId, { limit: 1000 }),
  ]);
  throwIfSupabaseError(recordingsResult.error);
  throwIfSupabaseError(messagesResult.error);

  const recordingSids = new Set((recordingsResult.data ?? []).map((row) => row.recording_sid).filter(Boolean));
  const messageSids = new Set((messagesResult.data ?? []).map((row) => row.twilio_message_sid).filter(Boolean));
  return {
    recordings: recordingSids.size,
    messages: messageSids.size,
    greetingFiles: greetingObjectsResult.error ? 0 : (greetingObjectsResult.data ?? []).length,
    databaseRows: Object.fromEntries(rows),
  };
}

export async function listAccountProviderResources(inputAccountId: string): Promise<TenantProviderResource[]> {
  const accountId = assertAccountId(inputAccountId, "listAccountProviderResources");
  const [leadRecordings, callRecordings, messages, inboundMessages] = await Promise.all([
    supabaseAdmin.from("leads").select("recording_sid").eq("account_id", accountId).not("recording_sid", "is", null),
    supabaseAdmin.from("calls").select("recording_sid").eq("account_id", accountId).not("recording_sid", "is", null),
    supabaseAdmin.from("messages").select("twilio_message_sid").eq("account_id", accountId).not("twilio_message_sid", "is", null),
    supabaseAdmin.from("inbound_messages").select("message_sid").eq("account_id", accountId),
  ]);
  for (const result of [leadRecordings, callRecordings, messages, inboundMessages]) {
    throwIfSupabaseError(result.error);
  }

  const recordings = new Set([
    ...(leadRecordings.data ?? []).map((row) => row.recording_sid),
    ...(callRecordings.data ?? []).map((row) => row.recording_sid),
  ].filter((sid): sid is string => typeof sid === "string" && Boolean(sid)));
  const messageSids = new Set([
    ...(messages.data ?? []).map((row) => row.twilio_message_sid),
    ...(inboundMessages.data ?? []).map((row) => row.message_sid),
  ].filter((sid): sid is string => typeof sid === "string" && Boolean(sid)));

  return [
    ...[...recordings].map((sid) => ({ accountId, sid, kind: "recording" as const })),
    ...[...messageSids].map((sid) => ({ accountId, sid, kind: "message" as const })),
  ];
}

export async function recordDataRetentionAction(input: {
  accountId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  status: "failed" | "completed";
  counts?: Record<string, number>;
  failureKinds?: string[];
}) {
  const { error } = await supabaseAdmin.from("data_retention_events").insert({
    target_account_id: input.accountId ?? null,
    actor_user_id: input.actorUserId ?? null,
    actor_email: input.actorEmail ?? null,
    action: input.action.slice(0, 100),
    status: input.status,
    counts: input.counts ?? {},
    failure_kinds: input.failureKinds ?? [],
  });
  throwIfSupabaseError(error);
}

export async function deleteAccountDatabaseData(input: {
  accountId: string;
  actorUserId: string;
  actorEmail: string | null;
}) {
  const accountId = assertAccountId(input.accountId, "deleteAccountDatabaseData");
  const { data, error } = await supabaseAdmin.rpc("delete_account_data", {
    p_account_id: accountId,
    p_actor_user_id: input.actorUserId,
    p_actor_email: input.actorEmail,
  });
  throwIfSupabaseError(error);
  return (data && typeof data === "object" ? data : {}) as Record<string, number>;
}

export async function exportAccountData(inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "exportAccountData");
  const accountResult = await supabaseAdmin.from("accounts").select("*").eq("id", accountId).maybeSingle();
  throwIfSupabaseError(accountResult.error);
  if (!accountResult.data) return null;

  const entries = await Promise.all(ACCOUNT_EXPORT_TABLES.map(async (table) => {
    const { data, error } = await supabaseAdmin.from(table).select("*").eq("account_id", accountId);
    throwIfSupabaseError(error);
    return [table, data ?? []] as const;
  }));
  const [stripeEvents, setupRequests, platformAudit, retentionEvents] = await Promise.all([
    supabaseAdmin.from("stripe_events").select("*").eq("account_id", accountId),
    supabaseAdmin.from("setup_requests").select("*").eq("account_id", accountId),
    supabaseAdmin.from("platform_audit_events").select("*").eq("target_account_id", accountId),
    supabaseAdmin.from("data_retention_events").select("*").eq("target_account_id", accountId),
  ]);
  for (const result of [stripeEvents, setupRequests, platformAudit, retentionEvents]) throwIfSupabaseError(result.error);

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    accountId,
    account: accountResult.data,
    data: {
      ...Object.fromEntries(entries),
      stripe_events: stripeEvents.data ?? [],
      setup_requests: setupRequests.data ?? [],
      platform_audit_events: platformAudit.data ?? [],
      data_retention_events: retentionEvents.data ?? [],
    },
    media: {
      note: "Recording and greeting references are included in table data; provider-hosted media bytes are not embedded in this JSON export.",
    },
  };
}
