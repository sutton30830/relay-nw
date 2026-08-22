import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import {
  getOpsAccountBySlug,
  listLeadsNeedingSummaryRetry,
  listLeadsNeedingTranscriptionRetry,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
} from "@/lib/supabase";
import { transcribeLeadVoicemail } from "@/lib/voicemail-ai";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_RECOVERY_ITEMS = 10;

type RecoveryResult = "recovered" | "no_work" | "partial" | "failed" | "account_not_found" | "inactive";

function go(
  slug: string,
  result: RecoveryResult,
  counts: { attempted?: number; recovered?: number; skipped?: number; failed?: number } = {},
): never {
  const params = new URLSearchParams({
    account: slug,
    voicemail_recovery: result,
  });

  for (const [key, value] of Object.entries(counts)) {
    if (typeof value === "number") params.set(key, String(value));
  }

  redirect(
    `/ops/monitoring?${params.toString()}#account-${encodeURIComponent(slug)}`,
  );
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.voicemailRecovery);
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim().slice(0, 80);

  if (!slug) redirect("/ops/monitoring");

  const account = await getOpsAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");
  if (account.accountStatus !== "active") go(account.accountSlug, "inactive");

  // Record the operator intent before touching voicemail state. This audit is
  // required so a manual recovery can never happen without durable attribution.
  await recordPlatformAuditEvent({
    actorUserId: operator.userId,
    actorEmail: operator.email,
    targetAccountId: account.accountId,
    action: OPS_ACTIONS.voicemailRecovery,
    summary: `Started safe voicemail recovery for ${account.businessName}`,
  }, { required: true });

  let transcriptionLeads: Array<{ id: string; account_id: string }>;
  let summaryLeads: Array<{ id: string; account_id: string }>;

  try {
    [transcriptionLeads, summaryLeads] = await Promise.all([
      // Unlike the daily bounded sweep, a deliberate account recovery includes
      // older unresolved calls that Monitoring may still surface.
      listLeadsNeedingTranscriptionRetry(MAX_RECOVERY_ITEMS, account.accountId, true),
      listLeadsNeedingSummaryRetry(MAX_RECOVERY_ITEMS, account.accountId),
    ]);
  } catch (error) {
    console.error("Could not list account-scoped voicemail recovery work", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    go(account.accountSlug, "failed", { failed: 1 });
  }

  const leads = [...new Map(
    [...transcriptionLeads, ...summaryLeads]
      .filter((lead) => lead.account_id === account.accountId)
      .map((lead) => [`${lead.account_id}:${lead.id}`, lead]),
  ).values()].slice(0, MAX_RECOVERY_ITEMS);

  if (leads.length === 0) {
    go(account.accountSlug, "no_work", {
      attempted: 0,
      recovered: 0,
      skipped: 0,
      failed: 0,
    });
  }

  let recovered = 0;
  let skipped = 0;
  let failed = 0;

  for (const lead of leads) {
    try {
      // Manual operator recovery is deliberately quiet: it updates the inbox,
      // provider evidence, and monitoring state without emailing or texting the owner.
      await transcribeLeadVoicemail(lead.id, account.accountId, { notifyOwner: false });
      recovered += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown voicemail recovery error";
      if (message === "Voicemail summary is already generating.") {
        skipped += 1;
        continue;
      }

      failed += 1;
      console.error("Operator voicemail recovery failed", {
        accountId: account.accountId,
        leadId: lead.id,
        error: message,
      });
    }
  }

  const auditSummary =
    `Finished safe voicemail recovery for ${account.businessName}: ` +
    `${recovered} recovered, ${skipped} already processing, ${failed} failed`;
  await Promise.all([
    recordAccountAuditEvents({
      accountId: account.accountId,
      actorUserId: operator.userId,
      actorEmail: operator.email,
      events: [{ action: OPS_ACTIONS.voicemailRecovery, summary: auditSummary }],
    }),
    recordPlatformAuditEvent({
      actorUserId: operator.userId,
      actorEmail: operator.email,
      targetAccountId: account.accountId,
      action: "voicemail.recovery.completed",
      summary: auditSummary,
    }),
  ]);

  const result: RecoveryResult = failed === 0
    ? "recovered"
    : recovered > 0 || skipped > 0
      ? "partial"
      : "failed";

  go(account.accountSlug, result, {
    attempted: leads.length,
    recovered,
    skipped,
    failed,
  });
}
