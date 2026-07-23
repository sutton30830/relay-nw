import { redirect } from "next/navigation";
import { requireAccountUser } from "@/lib/auth";
import { isSetupFeeSettled } from "@/lib/billing";
import { env } from "@/lib/env";
import {
  createStripeSetupFeeCheckoutSession,
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
  if (
    isSetupFeeSettled(
      billing.setupFeeStatus,
      billing.firstPaidAt,
      billing.billingPolicy,
    )
  ) {
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
    let existingUrl: string | null = null;

    if (billing.setupFeeCheckoutSessionId) {
      try {
        const existing = await retrieveStripeCheckoutSession(
          billing.setupFeeCheckoutSessionId,
        );
        if (
          existing.status === "open" &&
          existing.paymentStatus !== "paid" &&
          existing.url
        ) {
          existingUrl = existing.url;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/no such checkout|resource_missing/i.test(message)) throw error;
      }
    }

    if (existingUrl) {
      checkoutUrl = existingUrl;
    } else {
      const checkout = await createStripeSetupFeeCheckoutSession({
        accountId: session.accountId,
        accountSlug: session.account.accountSlug,
        ownerEmail: session.account.ownerEmail ?? session.email,
        stripeCustomerId: billing.stripeCustomerId,
        setupFeeCents: billing.setupFeeCents,
        idempotencyKey,
      });

      await updateAccountBillingRecord(session.accountId, {
        setupFeeCheckoutSessionId: checkout.id,
      });
      checkoutUrl = checkout.url;
    }
  } catch (error) {
    console.error("Stripe setup-fee checkout creation failed", {
      accountId: session.accountId,
      error: error instanceof Error ? error.message : error,
    });
    billingRedirect(env.stripeSetupFeePriceId ? "setup_fee_checkout_failed" : "setup_fee_not_configured");
  }

  redirect(checkoutUrl);
}
