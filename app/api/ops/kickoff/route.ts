import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import { isSetupFeeSettled } from "@/lib/billing";
import { commercialTermsForOffer } from "@/lib/customer-experience-contract";
import { notifyOwnerKickoffPayment } from "@/lib/email";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import {
  createStripePaymentMethodCheckoutSession,
  createStripeSetupFeeCheckoutSession,
  retrieveStripeCheckoutSession,
} from "@/lib/stripe-billing";
import {
  getAccountConfigByAccountId,
  getOpsBillingAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  updateAccountBillingRecord,
} from "@/lib/supabase";

function go(slug: string, result: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?kickoff=${result}`);
}

function resultResponse(request: Request, slug: string, result: string) {
  return Response.redirect(new URL(`/ops/accounts/${encodeURIComponent(slug)}?kickoff=${result}`, request.url), 303);
}

async function reusableCheckoutUrl(
  sessionId: string | null,
  requiresUnpaid: boolean,
) {
  if (!sessionId) return null;
  try {
    const existing = await retrieveStripeCheckoutSession(sessionId);
    if (
      existing.status === "open" &&
      (!requiresUnpaid || existing.paymentStatus !== "paid") &&
      existing.url
    ) {
      return existing.url;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such checkout|resource_missing/i.test(message)) throw error;
  }
  return null;
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.billingLinkSend);
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim();
  const action = String(form.get("action") ?? "").trim();
  if (!slug) redirect("/ops");

  const account = await getOpsBillingAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");
  const runtime = await getAccountConfigByAccountId(account.accountId);
  if (!runtime) go(account.accountSlug, "account_not_found");
  const billingEmail = runtime.ownerEmail;
  if (!billingEmail) go(account.accountSlug, "owner_email_missing");

  try {
    if (action === "send_invoice") {
      if (account.billingPolicy === "comped") {
        return resultResponse(request, account.accountSlug, "account_comped");
      }
      if (
        account.commercialOffer === "founding_pilot" &&
        account.billingPolicy !== "setup_fee_waived"
      ) {
        return resultResponse(request, account.accountSlug, "commercial_terms_incomplete");
      }

      const setupFeeSettled = isSetupFeeSettled(
        account.setupFeeStatus,
        account.firstPaidAt,
        account.billingPolicy,
      );
      if (setupFeeSettled) {
        if (account.stripeDefaultPaymentMethodId) {
          return resultResponse(request, account.accountSlug, "already_ready");
        }
        const terms = commercialTermsForOffer(account.commercialOffer);
        let checkoutUrl = await reusableCheckoutUrl(
          account.billingSetupCheckoutSessionId,
          false,
        );
        if (!checkoutUrl) {
          const checkout = await createStripePaymentMethodCheckoutSession({
            accountId: account.accountId,
            accountSlug: account.accountSlug,
            ownerEmail: billingEmail,
            stripeCustomerId: account.stripeCustomerId,
            trialDays: terms.trialDays,
            idempotencyKey: `relay-kickoff-card:${account.accountId}:${account.billingSetupCheckoutSessionId ?? "new"}`,
          });
          await updateAccountBillingRecord(account.accountId, {
            billingSetupCheckoutSessionId: checkout.id,
          });
          checkoutUrl = checkout.url;
        }
        const delivery = await notifyOwnerKickoffPayment({
          to: billingEmail,
          businessName: runtime.businessName,
          checkoutUrl,
          feeWaived: account.billingPolicy === "setup_fee_waived",
          setupFeeAlreadyPaid: account.billingPolicy !== "setup_fee_waived",
        });
        if (!delivery.sent) throw new Error("Kickoff card-setup email was not delivered.");
        await recordAccountAuditEvents({
          accountId: account.accountId,
          actorUserId: operator.userId,
          actorEmail: operator.email,
          events: [{
            action: "billing.kickoff.card_setup_started",
            summary: `Sent Stripe card setup for the delayed ${terms.trialDays}-day trial`,
          }],
        });
        await recordPlatformAuditEvent({
          actorUserId: operator.userId,
          actorEmail: operator.email,
          targetAccountId: account.accountId,
          action: "billing.kickoff.card_setup_started",
          summary: `Sent Stripe card setup for the delayed ${terms.trialDays}-day trial`,
        });
        return resultResponse(request, account.accountSlug, "payment_link_sent");
      }

      let checkoutUrl = await reusableCheckoutUrl(
        account.setupFeeCheckoutSessionId,
        true,
      );
      if (!checkoutUrl) {
        const checkout = await createStripeSetupFeeCheckoutSession({
          accountId: account.accountId,
          accountSlug: account.accountSlug,
          ownerEmail: billingEmail,
          stripeCustomerId: account.stripeCustomerId,
          setupFeeCents: account.setupFeeCents,
          // A refund/chargeback must create a new Checkout attempt. Including
          // the current state and its timestamp avoids Stripe returning the old,
          // already-completed session while remaining stable across double-clicks.
          idempotencyKey: `relay-kickoff-fee:${account.accountId}:${account.setupFeeStatus}:${account.setupFeeRefundedAt ?? account.setupFeeCheckoutSessionId ?? "new"}`,
        });
        if (!checkout.url) throw new Error("Stripe returned no setup-fee checkout URL.");
        await updateAccountBillingRecord(account.accountId, {
          setupFeeCheckoutSessionId: checkout.id,
        });
        checkoutUrl = checkout.url;
      }
      const delivery = await notifyOwnerKickoffPayment({
        to: billingEmail,
        businessName: runtime.businessName,
        checkoutUrl,
        feeWaived: false,
      });
      if (!delivery.sent) throw new Error("Kickoff payment email was not delivered.");
      await recordAccountAuditEvents({
        accountId: account.accountId,
        actorUserId: operator.userId,
        actorEmail: operator.email,
        events: [{
          action: "billing.kickoff.checkout_started",
          summary: "Sent the secure $150 Stripe setup-payment link",
        }],
      });
      await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetAccountId: account.accountId, action: "billing.kickoff.checkout_started", summary: "Started $150 kickoff payment" });
      return resultResponse(request, account.accountSlug, "payment_link_sent");
    }

    return resultResponse(request, account.accountSlug, "invalid_action");
  } catch (error) {
    console.error("Kickoff billing action failed", { accountId: account.accountId, action, error: error instanceof Error ? error.message : error });
    return resultResponse(request, account.accountSlug, "failed");
  }
}
