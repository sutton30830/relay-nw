import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import { addTrialDays } from "@/lib/billing";
import { billingUpdateFromSubscription, createStripeSubscriptionFromSavedCard, retrieveStripePaymentIntent } from "@/lib/stripe-billing";
import { getOpsBillingAccountBySlug, recordAccountAuditEvents, recordPlatformAuditEvent, updateAccountBillingRecord } from "@/lib/supabase";

export async function POST(request: Request) {
  const operator = await requirePlatformOperator();
  const form = await request.formData();
  const accountSlug = String(form.get("account_slug") ?? "").trim();
  const action = String(form.get("action") ?? "").trim();
  if (!accountSlug) redirect("/ops");
  const account = await getOpsBillingAccountBySlug(accountSlug);
  if (!account) redirect(`/ops/accounts/${encodeURIComponent(accountSlug)}?activation=account_not_found`);
  if (account.onboardingStatus !== "ready_to_activate") redirect(`/ops/accounts/${encodeURIComponent(account.accountSlug)}?activation=blocked`);
  if (action === "start_billing") {
    if (!account.stripeCustomerId || (!account.setupFeePaymentIntentId && !account.stripePaymentMethodId)) {
      redirect(`/ops/accounts/${encodeURIComponent(account.accountSlug)}?activation=card_missing`);
    }
    try {
      const payment = account.setupFeePaymentIntentId ? await retrieveStripePaymentIntent(account.setupFeePaymentIntentId) : null;
      const paymentMethodId = account.stripePaymentMethodId ?? payment?.paymentMethodId ?? null;
      if (!paymentMethodId || (payment?.customerId && payment.customerId !== account.stripeCustomerId)) {
        redirect(`/ops/accounts/${encodeURIComponent(account.accountSlug)}?activation=card_missing`);
      }
      const created = await createStripeSubscriptionFromSavedCard({
        accountId: account.accountId,
        accountSlug: account.accountSlug,
        customerId: account.stripeCustomerId,
        paymentMethodId,
        idempotencyKey: `relay-activate:${account.accountId}:${account.stripeSubscriptionId ?? "first"}`,
      });
      await updateAccountBillingRecord(account.accountId, billingUpdateFromSubscription(account.accountId, created.subscription));
      const summary = created.paymentActionRequired ? "Started monthly billing; customer payment approval is required" : "Started $99 monthly billing from the saved kickoff card";
      await recordAccountAuditEvents({ accountId: account.accountId, actorUserId: operator.userId, actorEmail: operator.email, events: [{ action: "billing.activation.start_billing", summary }] });
      await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetAccountId: account.accountId, action: "billing.activation.start_billing", summary });
      redirect(`/ops/accounts/${encodeURIComponent(account.accountSlug)}?activation=${created.paymentActionRequired ? "payment_action_required" : "start_billing"}`);
    } catch (error) {
      if (error && typeof error === "object" && "digest" in error) throw error;
      console.error("Saved-card activation failed", { accountId: account.accountId, error: error instanceof Error ? error.message : error });
      redirect(`/ops/accounts/${encodeURIComponent(account.accountSlug)}?activation=billing_failed`);
    }
  }
  const days = Math.min(90, Math.max(7, Number(form.get("trial_days") ?? 30) || 30));
  const update = action === "comp"
    ? { billingStatus: "comped" as const, onboardingStatus: "activated" as const, activatedAt: new Date().toISOString(), billingAttentionSince: null }
    : action === "trial"
      ? { billingStatus: "trialing" as const, onboardingStatus: "activated" as const, activatedAt: new Date().toISOString(), trialEndsAt: addTrialDays({ days }), billingAttentionSince: null }
      : null;
  if (!update) redirect(`/ops/accounts/${encodeURIComponent(account.accountSlug)}?activation=invalid_action`);
  await updateAccountBillingRecord(account.accountId, update);
  const summary = action === "comp" ? "Activated account as a comped pilot" : `Activated account with a ${days}-day trial`;
  await recordAccountAuditEvents({ accountId: account.accountId, actorUserId: operator.userId, actorEmail: operator.email, events: [{ action: `billing.activation.${action}`, summary }] });
  await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetAccountId: account.accountId, action: `billing.activation.${action}`, summary });
  redirect(`/ops/accounts/${encodeURIComponent(account.accountSlug)}?activation=${action}`);
}
