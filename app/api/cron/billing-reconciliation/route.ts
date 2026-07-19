import { reconcileStripeBillingAccount } from "@/lib/billing-reconciliation";
import { env } from "@/lib/env";
import { notifyAdminOperationalIssue } from "@/lib/email";
import {
  getOpsBillingAccountBySlug,
  listOpsAccounts,
  recordAccountAuditEvents,
} from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 300;

function authError(request: Request) {
  const authorization = request.headers.get("authorization");
  const valid = [env.cronSecret, env.billingReconciliationSecret]
    .filter((secret): secret is string => Boolean(secret))
    .some((secret) => authorization === `Bearer ${secret}`);
  if (!env.cronSecret && !env.billingReconciliationSecret) {
    return Response.json({ error: "Billing reconciliation authentication is not configured" }, { status: 503 });
  }
  if (!valid) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: Request) {
  const auth = authError(request);
  if (auth) return auth;

  const summaries = await listOpsAccounts();
  const results: Array<{ accountId: string; accountSlug: string; ok: boolean; checked?: object; error?: string }> = [];

  for (const summary of summaries) {
    const account = await getOpsBillingAccountBySlug(summary.accountSlug);
    if (!account || (!account.setupFeePaymentIntentId && !account.stripeSubscriptionId)) continue;
    try {
      const checked = await reconcileStripeBillingAccount(account);
      await recordAccountAuditEvents({
        accountId: account.accountId,
        actorUserId: null,
        actorEmail: "system:billing-reconciliation",
        events: [{ action: "billing.reconciled", summary: "Daily Stripe billing reconciliation completed" }],
      });
      results.push({ accountId: account.accountId, accountSlug: account.accountSlug, ok: true, checked });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown reconciliation error";
      console.error("Daily Stripe reconciliation failed", { accountId: account.accountId, error: message });
      results.push({ accountId: account.accountId, accountSlug: account.accountSlug, ok: false, error: message });
      try {
        await notifyAdminOperationalIssue({ issue: "Stripe reconciliation failed", detail: `${account.accountSlug}: ${message}`, correlationId: account.accountId });
      } catch (alertError) {
        console.error("Stripe reconciliation alert failed", { accountId: account.accountId, alertError });
      }
    }
  }

  const failed = results.filter((result) => !result.ok).length;
  return Response.json({ ok: failed === 0, checked: results.length, failed, results });
}
