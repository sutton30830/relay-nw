import { redirect } from "next/navigation";
import { requireAccountUser } from "@/lib/auth";
import { getBillingCheckoutEligibility } from "@/lib/billing";
import { createStripeCheckoutSession } from "@/lib/stripe-billing";
import {
  getAccountBillingRecord,
  getAccountTechnicalSetupStatus,
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

  const [billing, technicalStatus] = await Promise.all([
    getAccountBillingRecord(session.accountId),
    getAccountTechnicalSetupStatus(session.accountId),
  ]);
  const eligibility = getBillingCheckoutEligibility({
    billing,
    technicalStatus,
  });

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
