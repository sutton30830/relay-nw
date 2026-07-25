import {
  canStartMonthlyTrial,
  commercialTermsForOffer,
  type A2pRegistrationStatus,
} from "@/lib/customer-experience-contract";
import { isSetupFeeSettled } from "@/lib/billing";
import {
  assertStripeObjectMode,
  billingUpdateFromSubscription,
  createStripeTrialSubscription,
  listStripeSubscriptionsForCustomer,
  retrieveStripeCustomerBillingProfile,
  retrieveStripePaymentIntent,
  retrieveStripeSetupIntent,
  setStripeCustomerDefaultPaymentMethod,
  type StripeSubscriptionSnapshot,
} from "@/lib/stripe-billing";
import {
  getA2pRegistrationStatus,
  getAccountBillingRecord,
  getAccountConfigByAccountId,
  getAccountOperationalStatus,
  getAccountOpsBlocker,
  getAccountTechnicalSetupStatus,
  recordAccountAuditEvents,
  updateAccountBillingRecord,
} from "@/lib/supabase";

export type StripeTrialActivationResult =
  | { status: "created" | "already_started"; subscriptionId: string; trialEndsAt: string | null }
  | {
      status:
        | "not_eligible"
        | "setup_fee_required"
        | "payment_method_required"
        | "restart_required"
        | "comped"
        | "conflicting_subscription";
      reason: string;
    };

const NONTERMINAL_SUBSCRIPTION_STATUSES = new Set([
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
]);

function isA2pRegistrationStatus(value: string | null): value is A2pRegistrationStatus {
  return (
    value === "not_started" ||
    value === "in_progress" ||
    value === "approved" ||
    value === "needs_attention" ||
    value === "rejected" ||
    value === "paused"
  );
}

function isNonterminal(subscription: StripeSubscriptionSnapshot) {
  return Boolean(subscription.status && NONTERMINAL_SUBSCRIPTION_STATUSES.has(subscription.status));
}

async function synchronizeSubscription(
  accountId: string,
  subscription: StripeSubscriptionSnapshot,
) {
  assertStripeObjectMode(subscription.livemode, "Stripe subscription");
  await updateAccountBillingRecord(
    accountId,
    billingUpdateFromSubscription(accountId, subscription),
  );
}

async function resolveDefaultPaymentMethod(input: {
  accountId: string;
  stripeCustomerId: string;
  stripeSetupIntentId: string | null;
  setupFeePaymentIntentId: string | null;
}) {
  const customer = await retrieveStripeCustomerBillingProfile(input.stripeCustomerId);
  assertStripeObjectMode(customer.livemode, "Stripe customer");
  if (customer.defaultPaymentMethodId) return customer.defaultPaymentMethodId;

  if (input.stripeSetupIntentId) {
    const setupIntent = await retrieveStripeSetupIntent(input.stripeSetupIntentId);
    assertStripeObjectMode(setupIntent.livemode, "Stripe SetupIntent");
    if (
      setupIntent.status === "succeeded" &&
      setupIntent.customerId === input.stripeCustomerId &&
      setupIntent.paymentMethodId
    ) {
      const updated = await setStripeCustomerDefaultPaymentMethod({
        customerId: input.stripeCustomerId,
        paymentMethodId: setupIntent.paymentMethodId,
        idempotencyKey: `relay-default-payment-method:${input.accountId}:${setupIntent.id}`,
      });
      assertStripeObjectMode(updated.livemode, "Stripe customer");
      return updated.defaultPaymentMethodId;
    }
  }

  if (input.setupFeePaymentIntentId) {
    const payment = await retrieveStripePaymentIntent(input.setupFeePaymentIntentId);
    assertStripeObjectMode(payment.livemode, "Stripe PaymentIntent");
    if (
      payment.status === "succeeded" &&
      payment.customerId === input.stripeCustomerId &&
      payment.paymentMethodId
    ) {
      const updated = await setStripeCustomerDefaultPaymentMethod({
        customerId: input.stripeCustomerId,
        paymentMethodId: payment.paymentMethodId,
        idempotencyKey: `relay-default-payment-method:${input.accountId}:${payment.id}`,
      });
      assertStripeObjectMode(updated.livemode, "Stripe customer");
      return updated.defaultPaymentMethodId;
    }
  }

  return null;
}

export async function activateStripeTrialForAccount(
  accountId: string,
): Promise<StripeTrialActivationResult> {
  const [billing, technicalStatus, operationalStatus, a2pValue, account, blocker] = await Promise.all([
    getAccountBillingRecord(accountId),
    getAccountTechnicalSetupStatus(accountId),
    getAccountOperationalStatus(accountId),
    getA2pRegistrationStatus(accountId),
    getAccountConfigByAccountId(accountId),
    getAccountOpsBlocker(accountId),
  ]);

  if (!account) {
    return { status: "not_eligible", reason: "account_not_found" };
  }

  if (operationalStatus !== "active") {
    return {
      status: "not_eligible",
      reason: operationalStatus === "archived" ? "account_closed" : "account_paused",
    };
  }

  if (billing.billingPolicy === "comped") {
    return { status: "comped", reason: "relay_policy_comped" };
  }

  const a2pStatus = isA2pRegistrationStatus(a2pValue) ? a2pValue : "not_started";
  if (!canStartMonthlyTrial({
    technicalStatus,
    a2pStatus,
    smsEnabled: account.smsEnabled,
    blockedBy: blocker.blockedBy,
  })) {
    return {
      status: "not_eligible",
      reason: blocker.blockedBy === "none"
        ? "automatic_text_back_not_active"
        : `operations_blocked_by_${blocker.blockedBy}`,
    };
  }

  if (!isSetupFeeSettled(
    billing.setupFeeStatus,
    billing.firstPaidAt,
    billing.billingPolicy,
  )) {
    return { status: "setup_fee_required", reason: "setup_fee_not_settled" };
  }

  if (!billing.stripeCustomerId) {
    return { status: "payment_method_required", reason: "stripe_customer_missing" };
  }

  const defaultPaymentMethodId = await resolveDefaultPaymentMethod({
    accountId,
    stripeCustomerId: billing.stripeCustomerId,
    stripeSetupIntentId: billing.stripeSetupIntentId,
    setupFeePaymentIntentId: billing.setupFeePaymentIntentId,
  });
  if (!defaultPaymentMethodId) {
    await updateAccountBillingRecord(accountId, {
      stripeDefaultPaymentMethodId: null,
      paymentMethodUpdatedAt: new Date().toISOString(),
    });
    return { status: "payment_method_required", reason: "stripe_default_payment_method_missing" };
  }

  await updateAccountBillingRecord(accountId, {
    stripeDefaultPaymentMethodId: defaultPaymentMethodId,
    paymentMethodUpdatedAt: new Date().toISOString(),
  });

  const subscriptions = await listStripeSubscriptionsForCustomer(billing.stripeCustomerId);
  for (const subscription of subscriptions) {
    assertStripeObjectMode(subscription.livemode, "Stripe subscription");
  }

  const existing = subscriptions.find((subscription) =>
    isNonterminal(subscription) &&
    (
      subscription.id === billing.stripeSubscriptionId ||
      subscription.metadataAccountId === accountId
    ));
  if (existing) {
    await synchronizeSubscription(accountId, existing);
    return {
      status: "already_started",
      subscriptionId: existing.id,
      trialEndsAt: existing.trialEndsAt,
    };
  }

  const conflict = subscriptions.find((subscription) => isNonterminal(subscription));
  if (conflict) {
    return {
      status: "conflicting_subscription",
      reason: `stripe_customer_has_${conflict.status ?? "unknown"}_subscription`,
    };
  }

  // A free trial is granted once. Returning customers restart on-session in
  // Stripe Checkout so an immediate invoice can be authenticated safely.
  if (
    billing.activatedAt ||
    billing.firstPaidAt ||
    billing.canceledAt ||
    billing.billingStatus === "canceled"
  ) {
    return { status: "restart_required", reason: "initial_trial_already_used" };
  }

  const terms = commercialTermsForOffer(billing.commercialOffer);
  const priorTerminalId = subscriptions.find((subscription) =>
    subscription.metadataAccountId === accountId)?.id ?? "initial";
  const subscription = await createStripeTrialSubscription({
    accountId,
    accountSlug: account.accountSlug,
    commercialOffer: billing.commercialOffer,
    customerId: billing.stripeCustomerId,
    defaultPaymentMethodId,
    trialDays: terms.trialDays,
    idempotencyKey: `relay-trial-activation:${accountId}:${priorTerminalId}:${billing.commercialOffer}:v1`,
  });
  assertStripeObjectMode(subscription.livemode, "Stripe subscription");
  if (
    subscription.status !== "trialing" ||
    subscription.customerId !== billing.stripeCustomerId ||
    subscription.metadataAccountId !== accountId
  ) {
    throw new Error("Stripe did not create the expected account-scoped trial subscription.");
  }

  await synchronizeSubscription(accountId, subscription);
  void recordAccountAuditEvents({
    accountId,
    actorUserId: null,
    actorEmail: "system:stripe-trial-activation",
    events: [{
      action: "billing.trial.started",
      summary: `Stripe started the ${terms.trialDays}-day ${billing.commercialOffer.replaceAll("_", " ")} trial after automatic text-back activation`,
    }],
  }).catch((error) => console.error("Stripe trial activation audit failed", {
    accountId,
    error: error instanceof Error ? error.message : error,
  }));

  return {
    status: "created",
    subscriptionId: subscription.id,
    trialEndsAt: subscription.trialEndsAt,
  };
}
