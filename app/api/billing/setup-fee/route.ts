import { redirect } from "next/navigation";
import { requireAccountUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { createStripeSetupFeeCheckoutSession } from "@/lib/stripe-billing";
import { getAccountBillingRecord, updateAccountBillingRecord } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function billingRedirect(reason: string): never {
  redirect(`/settings?billing=${reason}#billing`);
}

export async function POST() {
  const session = await requireAccountUser();

  if (session.role !== "owner") billingRedirect("forbidden");

  const billing = await getAccountBillingRecord(session.accountId);
  if (billing.setupFeeStatus === "paid" || billing.setupFeeStatus === "waived") {
    billingRedirect("setup_fee_settled");
  }

  const idempotencyKey = [
    "relay-setup-fee",
    session.accountId,
    billing.setupFeeStatus,
    billing.setupFeeCheckoutSessionId ?? "new-session",
  ].join(":");

  let checkoutUrl: string;

  try {
    const checkout = await createStripeSetupFeeCheckoutSession({
      accountId: session.accountId,
      accountSlug: session.account.accountSlug,
      ownerEmail: session.account.ownerEmail ?? session.email,
      stripeCustomerId: billing.stripeCustomerId,
      setupFeeCents: billing.setupFeeCents,
      idempotencyKey,
    });

    // Store the session before redirecting so a double-click or abandoned
    // checkout is visible to operators and reuses the same Stripe idempotency
    // identity on retry.
    await updateAccountBillingRecord(session.accountId, {
      setupFeeCheckoutSessionId: checkout.id,
    });
    checkoutUrl = checkout.url;
  } catch (error) {
    console.error("Stripe setup-fee checkout creation failed", {
      accountId: session.accountId,
      error: error instanceof Error ? error.message : error,
    });
    billingRedirect(env.stripeSetupFeePriceId ? "setup_fee_checkout_failed" : "setup_fee_not_configured");
  }

  redirect(checkoutUrl);
}
