import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import { getBillingCheckoutEligibility } from "@/lib/billing";
import { computeSetupReadiness, type A2pStatus } from "@/lib/readiness";
import { createStripeCheckoutSession } from "@/lib/stripe-billing";
import {
  getA2pRegistrationStatus,
  getAccountBillingRecord,
  getAccountRecoveryStats,
  getAccountConfigByAccountId,
  getForwardingHealthSummary,
  getLastRecoveredCallAt,
  getOpsBillingAccountBySlug,
  recordPlatformAuditEvent,
} from "@/lib/supabase";

export const dynamic = "force-dynamic";

function redirectWith(accountSlug: string, status: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(accountSlug)}?billing_action=${status}`);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperator();
  const formData = await request.formData();
  const accountSlug = String(formData.get("account_slug") ?? "").trim();
  if (!accountSlug) redirect("/ops");

  const account = await getOpsBillingAccountBySlug(accountSlug);
  if (!account) redirectWith(accountSlug, "account_not_found");

  const runtime = await getAccountConfigByAccountId(account.accountId);
  if (!runtime) redirectWith(account.accountSlug, "account_not_found");

  const [forwardingHealth, a2pStatus, recovery, lastRecoveredCallAt, billing] = await Promise.all([
    getForwardingHealthSummary(account.accountId),
    getA2pRegistrationStatus(account.accountId),
    getAccountRecoveryStats(account.accountId, { since: null }),
    getLastRecoveredCallAt(account.accountId),
    getAccountBillingRecord(account.accountId),
  ]);
  const setupReadiness = computeSetupReadiness({
    role: "owner",
    hasProfile: Boolean(runtime.businessName && runtime.ownerPhoneNumber && runtime.twilioPhoneNumber),
    callMode: runtime.callMode,
    smsEnabled: runtime.smsEnabled,
    a2pStatus: (["not_started", "in_progress", "approved", "rejected", "paused"].includes(a2pStatus ?? "")
      ? a2pStatus
      : "unknown") as A2pStatus,
    forwardingStatus: forwardingHealth.displayStatus,
    hasRecoveredCall: recovery.missedCalls > 0,
    lastRecoveredCallAt,
    forwardingLastPassedAt: forwardingHealth.lastPassedAt,
  });
  const eligibility = getBillingCheckoutEligibility({ billing, setupReadiness });
  if (!eligibility.ok) redirectWith(account.accountSlug, eligibility.reason);

  let checkoutUrl: string;
  try {
    const checkout = await createStripeCheckoutSession({
      accountId: account.accountId,
      accountSlug: account.accountSlug,
      ownerEmail: runtime.ownerEmail ?? operator.email,
      stripeCustomerId: billing.stripeCustomerId,
      trialPeriodDays: 0,
      idempotencyKey: [
        "relay-ops-checkout",
        account.accountId,
        billing.billingStatus,
        billing.stripeCustomerId ?? "new-customer",
        billing.stripeSubscriptionId ?? "no-subscription",
      ].join(":"),
    });
    checkoutUrl = checkout.url;
    await recordPlatformAuditEvent({
      actorUserId: operator.userId,
      actorEmail: operator.email,
      targetAccountId: account.accountId,
      action: "billing.operator.checkout_started",
      summary: "Started activation-gated monthly subscription Checkout for the selected account.",
    });
  } catch (error) {
    console.error("Operator Stripe checkout creation failed", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    redirectWith(account.accountSlug, "checkout_failed");
  }

  redirect(checkoutUrl);
}
