import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import { notifyOwnerKickoffPayment } from "@/lib/email";
import { createStripeSaveCardCheckoutSession, createStripeSetupFeeCheckoutSession } from "@/lib/stripe-billing";
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

export async function POST(request: Request) {
  const operator = await requirePlatformOperator();
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim();
  const action = String(form.get("action") ?? "").trim();
  if (!slug) redirect("/ops");

  const account = await getOpsBillingAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");
  const runtime = await getAccountConfigByAccountId(account.accountId);
  if (!runtime) go(account.accountSlug, "account_not_found");
  const billingEmail = runtime.ownerEmail ?? operator.email;
  if (!billingEmail) go(account.accountSlug, "owner_email_missing");

  try {
    if (action === "waive_entirely") {
      await updateAccountBillingRecord(account.accountId, {
        setupFeeStatus: "waived",
        setupFeeWaivedAt: new Date().toISOString(),
        setupFeeWaiverReason: "Operator waived kickoff fee at kickoff.",
      });
      await recordAccountAuditEvents({ accountId: account.accountId, actorUserId: operator.userId, actorEmail: operator.email, events: [{ action: "billing.kickoff.waived", summary: "Waived $150 kickoff fee entirely" }] });
      await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetAccountId: account.accountId, action: "billing.kickoff.waived", summary: "Waived $150 kickoff fee entirely" });
      return resultResponse(request, account.accountSlug, "waived");
    }

    if (action === "waive_save_card") {
      const checkout = await createStripeSaveCardCheckoutSession({
        accountId: account.accountId,
        accountSlug: account.accountSlug,
        ownerEmail: billingEmail,
        stripeCustomerId: account.stripeCustomerId,
        idempotencyKey: `relay-kickoff-card:${account.accountId}:${account.stripeCustomerId ?? "new"}`,
      });
      if (!checkout.url) throw new Error("Stripe returned no card-save URL.");
      await updateAccountBillingRecord(account.accountId, {
        setupFeeStatus: "waived",
        setupFeeWaivedAt: new Date().toISOString(),
        setupFeeWaiverReason: "Operator waived kickoff fee and requested card on file.",
        setupFeeCheckoutSessionId: checkout.id,
      });
      const delivery = await notifyOwnerKickoffPayment({
        to: billingEmail,
        businessName: runtime.businessName,
        checkoutUrl: checkout.url,
        feeWaived: true,
      });
      if (!delivery.sent) throw new Error("Card-save email was not delivered.");
      await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetAccountId: account.accountId, action: "billing.kickoff.card_save_started", summary: "Waived $150 kickoff fee and started card-on-file setup" });
      return resultResponse(request, account.accountSlug, "card_link_sent");
    }

    if (action === "send_invoice") {
      const checkout = await createStripeSetupFeeCheckoutSession({
        accountId: account.accountId,
        accountSlug: account.accountSlug,
        ownerEmail: billingEmail,
        stripeCustomerId: account.stripeCustomerId,
        setupFeeCents: account.setupFeeCents,
        idempotencyKey: `relay-kickoff-fee:${account.accountId}:${account.setupFeeCheckoutSessionId ?? "new"}`,
      });
      if (!checkout.url) throw new Error("Stripe returned no setup-fee checkout URL.");
      await updateAccountBillingRecord(account.accountId, { setupFeeCheckoutSessionId: checkout.id });
      const delivery = await notifyOwnerKickoffPayment({
        to: billingEmail,
        businessName: runtime.businessName,
        checkoutUrl: checkout.url,
        feeWaived: false,
      });
      if (!delivery.sent) throw new Error("Kickoff payment email was not delivered.");
      await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetAccountId: account.accountId, action: "billing.kickoff.checkout_started", summary: "Started $150 kickoff payment" });
      return resultResponse(request, account.accountSlug, "payment_link_sent");
    }

    return resultResponse(request, account.accountSlug, "invalid_action");
  } catch (error) {
    console.error("Kickoff billing action failed", { accountId: account.accountId, action, error: error instanceof Error ? error.message : error });
    return resultResponse(request, account.accountSlug, "failed");
  }
}
