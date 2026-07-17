import { redirect } from "next/navigation";
import { requireAccountUser } from "@/lib/auth";
import { getBillingCheckoutEligibility } from "@/lib/billing";
import { computeSetupReadiness, type A2pStatus } from "@/lib/readiness";
import { createStripeCheckoutSession } from "@/lib/stripe-billing";
import {
  getA2pRegistrationStatus,
  getAccountBillingRecord,
  getAccountRecoveryStats,
  getForwardingHealthSummary,
  getLastRecoveredCallAt,
} from "@/lib/supabase";

export const dynamic = "force-dynamic";

function billingRedirect(reason: string): never {
  redirect(`/settings?billing=${reason}#billing`);
}

function checkoutIdempotencyKey(input: {
  accountId: string;
  billingStatus: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}) {
  return [
    "relay-checkout",
    input.accountId,
    input.billingStatus,
    input.stripeCustomerId ?? "new-customer",
    input.stripeSubscriptionId ?? "no-subscription",
  ].join(":");
}

export async function POST() {
  const session = await requireAccountUser();

  if (session.role !== "owner") {
    billingRedirect("forbidden");
  }

  const [billing, forwardingHealth, a2pStatus, recovery, lastRecoveredCallAt] = await Promise.all([
    getAccountBillingRecord(session.accountId),
    getForwardingHealthSummary(session.accountId),
    getA2pRegistrationStatus(session.accountId),
    getAccountRecoveryStats(session.accountId, { since: null }),
    getLastRecoveredCallAt(session.accountId),
  ]);
  const setupReadiness = computeSetupReadiness({
    role: session.role,
    hasProfile: Boolean(
      session.account.businessName &&
      session.account.ownerPhoneNumber &&
      session.account.twilioPhoneNumber,
    ),
    callMode: session.account.callMode,
    smsEnabled: session.account.smsEnabled,
    a2pStatus: (["not_started", "in_progress", "approved", "rejected", "paused"].includes(a2pStatus ?? "")
      ? a2pStatus
      : "unknown") as A2pStatus,
    forwardingStatus: forwardingHealth.displayStatus,
    hasRecoveredCall: recovery.missedCalls > 0,
    lastRecoveredCallAt,
    forwardingLastPassedAt: forwardingHealth.lastPassedAt,
  });
  const eligibility = getBillingCheckoutEligibility({ billing, setupReadiness });

  if (!eligibility.ok) {
    billingRedirect(eligibility.reason);
  }

  let checkoutUrl: string;

  try {
    const checkout = await createStripeCheckoutSession({
      accountId: session.accountId,
      accountSlug: session.account.accountSlug,
      ownerEmail: session.account.ownerEmail ?? session.email,
      stripeCustomerId: billing.stripeCustomerId,
      idempotencyKey: checkoutIdempotencyKey({
        accountId: session.accountId,
        billingStatus: billing.billingStatus,
        stripeCustomerId: billing.stripeCustomerId,
        stripeSubscriptionId: billing.stripeSubscriptionId,
      }),
    });
    checkoutUrl = checkout.url;
  } catch (error) {
    console.error("Stripe checkout creation failed", {
      accountId: session.accountId,
      error: error instanceof Error ? error.message : error,
    });

    billingRedirect("checkout_failed");
  }

  redirect(checkoutUrl);
}
