import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import {
  getOpsAccountBySlug,
  listLeadsNeedingSummaryRetry,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
} from "@/lib/supabase";
import { transcribeLeadVoicemail } from "@/lib/voicemail-ai";

function go(slug: string, result: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?voicemail_recovery=${result}#onboarding`);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.voicemailRecovery);
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim().slice(0, 80);
  if (!slug) redirect("/ops");

  const account = await getOpsAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");

  let leads: Array<{ id: string; account_id: string }>;
  try {
    leads = await listLeadsNeedingSummaryRetry(25, account.accountId);
  } catch (error) {
    console.error("Ops voicemail recovery lookup failed", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    go(slug, "failed");
  }

  let succeeded = 0;
  const failures: string[] = [];
  for (const lead of leads) {
    try {
      await transcribeLeadVoicemail(lead.id, account.accountId);
      succeeded += 1;
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "Unknown summary recovery error");
    }
  }

  const summary = leads.length === 0
    ? "Checked for recoverable voicemail summaries; none were eligible"
    : `Attempted ${leads.length} voicemail summary recoveries; ${succeeded} succeeded and ${failures.length} failed`;
  await Promise.all([
    recordAccountAuditEvents({
      accountId: account.accountId,
      actorUserId: operator.userId,
      actorEmail: operator.email,
      events: [{ action: "voicemail.summary_recovery_requested", summary }],
    }),
    recordPlatformAuditEvent({
      actorUserId: operator.userId,
      actorEmail: operator.email,
      targetAccountId: account.accountId,
      action: "voicemail.summary_recovery_requested",
      summary,
    }),
  ]);

  if (leads.length === 0) go(slug, "none");
  if (failures.length > 0) go(slug, succeeded > 0 ? "partial" : "failed");
  go(slug, "completed");
}
