import "server-only";

import { env } from "@/lib/env";
import { removeGreetingFiles } from "@/lib/greeting-storage";
import { runAccountDeletion } from "@/lib/retention-core";
import {
  deleteAccountDatabaseData,
  listAccountProviderResources,
  loadAccountDeletionTarget,
  previewAccountDeletion,
  recordDataRetentionAction,
  supabaseAdmin,
  wasAccountDeletionCompleted,
} from "@/lib/supabase";
import { twilioClient } from "@/lib/twilio";

const DAY_MS = 24 * 60 * 60 * 1000;

function cutoff(now: Date, days: number) {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}
function isTwilioMissing(error: unknown) {
  return Boolean(
    error && typeof error === "object" &&
    ("status" in error && error.status === 404 || "code" in error && error.code === 20404),
  );
}

async function deleteTwilioResource(resource: { kind: "recording" | "message"; sid: string }) {
  try {
    if (resource.kind === "recording") {
      await twilioClient.recordings(resource.sid).remove();
    } else {
      await twilioClient.messages(resource.sid).remove();
    }
    return "deleted" as const;
  } catch (error) {
    if (isTwilioMissing(error)) return "not_found" as const;
    throw error;
  }
}

export async function deleteAccountWithProviders(input: {
  accountId: string;
  actorUserId: string;
  actorEmail: string | null;
  dryRun: boolean;
}) {
  return runAccountDeletion({
    ...input,
    dependencies: {
      loadTarget: loadAccountDeletionTarget,
      wasDeletionCompleted: wasAccountDeletionCompleted,
      preview: async (accountId) => {
        const preview = await previewAccountDeletion(accountId);
        const greetingFiles = await import("@/lib/greeting-storage").then(({ listGreetingFiles }) => listGreetingFiles(accountId));
        return { ...preview, greetingFiles: greetingFiles.length };
      },
      listProviderResources: listAccountProviderResources,
      deleteProviderResource: deleteTwilioResource,
      deleteGreetingFiles: removeGreetingFiles,
      deleteDatabaseAccount: deleteAccountDatabaseData,
      recordAction: recordDataRetentionAction,
    },
  });
}

export type OperationalRetentionReport = {
  dryRun: boolean;
  cutoffs: { webhookEvents: string; inboundMessageBodies: string };
  candidates: { webhookEvents: number; inboundMessageBodies: number; twilioMessages: number };
  deleted: { webhookEvents: number; inboundMessageBodies: number; twilioMessages: number };
  providerFailures: number;
};

async function countBefore(table: string, timestamp: string, filters?: (query: any) => any) {
  let query = supabaseAdmin.from(table).select("*", { count: "exact", head: true }).lt("created_at", timestamp);
  if (filters) query = filters(query);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export async function runOperationalRetention(input: {
  dryRun: boolean;
  now?: Date;
  accountId?: string;
}): Promise<OperationalRetentionReport> {
  const now = input.now ?? new Date();
  const webhookCutoff = cutoff(now, env.webhookEventRetentionDays);
  const inboundCutoff = cutoff(now, env.inboundMessageRetentionDays);
  const scope = (query: any) => input.accountId ? query.eq("account_id", input.accountId) : query;

  const [webhookCount, inboundCount, duplicateMessageCount, inboundCandidates] = await Promise.all([
    countBefore("webhook_events", webhookCutoff, scope),
    countBefore("inbound_messages", inboundCutoff, (query) => scope(query).not("body", "is", null)),
    countBefore("messages", inboundCutoff, (query) => scope(query).eq("direction", "inbound").not("body", "is", null)),
    (() => {
      let query = supabaseAdmin.from("inbound_messages").select("account_id, message_sid").lt("created_at", inboundCutoff);
      query = scope(query);
      return query;
    })(),
  ]);
  if (inboundCandidates.error) throw inboundCandidates.error;
  const candidates = (inboundCandidates.data ?? []) as Array<{ account_id: string; message_sid: string }>;
  const report: OperationalRetentionReport = {
    dryRun: input.dryRun,
    cutoffs: { webhookEvents: webhookCutoff, inboundMessageBodies: inboundCutoff },
    candidates: {
      webhookEvents: webhookCount,
      inboundMessageBodies: inboundCount + duplicateMessageCount,
      twilioMessages: candidates.length,
    },
    deleted: { webhookEvents: 0, inboundMessageBodies: 0, twilioMessages: 0 },
    providerFailures: 0,
  };
  if (input.dryRun) return report;

  for (const candidate of candidates) {
    try {
      await deleteTwilioResource({ kind: "message", sid: candidate.message_sid });
      report.deleted.twilioMessages += 1;
    } catch {
      report.providerFailures += 1;
    }
  }

  let webhookDelete = supabaseAdmin.from("webhook_events").delete().lt("created_at", webhookCutoff);
  webhookDelete = scope(webhookDelete);
  const webhookResult = await webhookDelete.select("id");
  if (webhookResult.error) throw webhookResult.error;
  report.deleted.webhookEvents = webhookResult.data?.length ?? 0;

  let inboundScrub = supabaseAdmin.from("inbound_messages").update({ body: null }).lt("created_at", inboundCutoff).not("body", "is", null);
  inboundScrub = scope(inboundScrub);
  const inboundResult = await inboundScrub.select("id");
  if (inboundResult.error) throw inboundResult.error;

  let duplicateScrub = supabaseAdmin.from("messages").update({ body: null }).eq("direction", "inbound").lt("created_at", inboundCutoff).not("body", "is", null);
  duplicateScrub = scope(duplicateScrub);
  const duplicateResult = await duplicateScrub.select("id");
  if (duplicateResult.error) throw duplicateResult.error;
  report.deleted.inboundMessageBodies = (inboundResult.data?.length ?? 0) + (duplicateResult.data?.length ?? 0);

  await recordDataRetentionAction({
    accountId: input.accountId ?? null,
    action: "retention.operational",
    status: report.providerFailures > 0 ? "failed" : "completed",
    counts: report.deleted,
    failureKinds: report.providerFailures > 0 ? ["twilio_message"] : [],
  });
  return report;
}
