import { reconcileStripeBillingAccount } from "@/lib/billing-reconciliation";
import { activateStripeTrialForAccount } from "@/lib/billing-activation";
import { env } from "@/lib/env";
import { notifyAdminOperationalIssue } from "@/lib/email";
import {
  getOpsBillingAccountBySlug,
  listOpsAccounts,
  recordAccountAuditEvents,
  recordProviderAction,
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
    if (!account || (
      !account.setupFeeCheckoutSessionId &&
      !account.setupFeePaymentIntentId &&
      !account.billingSetupCheckoutSessionId &&
      !account.stripeSetupIntentId &&
      !account.stripeCustomerId &&
      !account.stripeSubscriptionId
    )) continue;
    const runDate = new Date().toISOString().slice(0, 10);
    const actionKey = `stripe_reconciliation:${account.accountId}:${runDate}`;
    const recordReconciliationAction = async (event: Parameters<typeof recordProviderAction>[0]) => {
      try {
        await recordProviderAction(event);
      } catch (actionError) {
        console.error("Billing reconciliation action evidence could not be recorded", {
          accountId: account.accountId,
          actionError,
        });
      }
    };
    try {
      await recordReconciliationAction({
        accountId: account.accountId,
        action: "scheduled_billing_reconciliation",
        provider: "stripe",
        idempotencyKey: actionKey,
        resourceType: "account",
        resourceId: account.accountId,
        internalStatus: "processing",
        providerStatus: "reconciling",
        customerExplanation: "Relay is checking the latest billing status.",
        retryEligibility: "automatic",
        recommendedNextAction: "Wait for reconciliation to finish.",
        customerVisible: false,
        countAttempt: true,
      });
      const checked = await reconcileStripeBillingAccount(account);
      const activation = await activateStripeTrialForAccount(account.accountId);
      await recordAccountAuditEvents({
        accountId: account.accountId,
        actorUserId: null,
        actorEmail: "system:billing-reconciliation",
        events: [{ action: "billing.reconciled", summary: "Daily Stripe billing reconciliation completed" }],
      });
      await recordReconciliationAction({
        accountId: account.accountId,
        action: "scheduled_billing_reconciliation",
        provider: "stripe",
        idempotencyKey: actionKey,
        resourceType: "account",
        resourceId: account.accountId,
        internalStatus: "reconciled",
        providerStatus: "current",
        customerExplanation: "The billing status is current.",
        retryEligibility: "never",
        recommendedNextAction: "No action is needed.",
        customerVisible: false,
      });
      results.push({ accountId: account.accountId, accountSlug: account.accountSlug, ok: true, checked: { ...checked, activation } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown reconciliation error";
      console.error("Daily Stripe reconciliation failed", { accountId: account.accountId, error: message });
      await recordReconciliationAction({
        accountId: account.accountId,
        action: "scheduled_billing_reconciliation",
        provider: "stripe",
        idempotencyKey: actionKey,
        resourceType: "account",
        resourceId: account.accountId,
        internalStatus: "failed",
        providerStatus: "reconciliation_failed",
        diagnosticDetail: error,
        customerVisible: true,
      });
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
