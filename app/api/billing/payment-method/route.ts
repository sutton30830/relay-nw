import { redirect } from "next/navigation";
import { requireAccountUser } from "@/lib/auth";
import { isSetupFeeSettled } from "@/lib/billing";
import { commercialTermsForOffer } from "@/lib/customer-experience-contract";
import {
  createStripePaymentMethodCheckoutSession,
  retrieveStripeCheckoutSession,
} from "@/lib/stripe-billing";
import { getAccountBillingRecord, updateAccountBillingRecord } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function billingRedirect(reason: string): never {
  redirect(`/settings?billing=${reason}#billing`);
}

export async function POST() {
  const session = await requireAccountUser();
  if (session.role !== "owner") billingRedirect("forbidden");

  const billing = await getAccountBillingRecord(session.accountId);
  if (billing.billingPolicy === "comped") billingRedirect("already_active");
  if (billing.stripeDefaultPaymentMethodId) billingRedirect("payment_method_ready");
  if (!isSetupFeeSettled(
    billing.setupFeeStatus,
    billing.firstPaidAt,
    billing.billingPolicy,
  )) {
    billingRedirect("setup_fee_required");
  }

  const terms = commercialTermsForOffer(billing.commercialOffer);
  const idempotencyKey = [
    "relay-payment-method",
    session.accountId,
    billing.commercialOffer,
    billing.billingSetupCheckoutSessionId ?? "new-session",
  ].join(":");

  let checkoutUrl: string;
  try {
    let existingUrl: string | null = null;
    if (billing.billingSetupCheckoutSessionId) {
      try {
        const existing = await retrieveStripeCheckoutSession(
          billing.billingSetupCheckoutSessionId,
        );
        if (existing.status === "open" && existing.url) existingUrl = existing.url;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such checkout|resource_missing/i.test(message)) throw error;
      }
    }

    if (existingUrl) {
      checkoutUrl = existingUrl;
    } else {
      const checkout = await createStripePaymentMethodCheckoutSession({
        accountId: session.accountId,
        accountSlug: session.account.accountSlug,
        ownerEmail: session.account.ownerEmail ?? session.email,
        stripeCustomerId: billing.stripeCustomerId,
        trialDays: terms.trialDays,
        idempotencyKey,
      });
      await updateAccountBillingRecord(session.accountId, {
        billingSetupCheckoutSessionId: checkout.id,
      });
      checkoutUrl = checkout.url;
    }
  } catch (error) {
    console.error("Stripe payment-method Checkout creation failed", {
      accountId: session.accountId,
      error: error instanceof Error ? error.message : error,
    });
    billingRedirect("payment_method_checkout_failed");
  }

  redirect(checkoutUrl);
}
