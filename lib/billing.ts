import {
  canStartMonthlyTrial,
  commercialTermsForOffer,
  type A2pRegistrationStatus,
  type BillingPolicy,
  type CommercialOffer,
  type TechnicalSetupStatus,
} from "@/lib/customer-experience-contract";

export type { BillingPolicy, CommercialOffer } from "@/lib/customer-experience-contract";

export type AccountBillingStatus = "not_started" | "trialing" | "active" | "past_due" | "canceled" | "comped";

export type AccountOnboardingStatus = TechnicalSetupStatus;

export type StripeSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

export type BillingOwnerAction =
  | "none"
  | "pay_setup_fee"
  | "add_payment_method"
  | "finish_setup"
  | "wait_for_activation"
  | "manage_billing"
  | "update_payment"
  | "restart_subscription"
  | "contact_support";

export type AccountBillingRecord = {
  billingStatus: AccountBillingStatus;
  billingPolicy: BillingPolicy;
  commercialOffer: CommercialOffer;
  onboardingStatus: AccountOnboardingStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  stripeSubscriptionStatus: StripeSubscriptionStatus | null;
  billingSetupCheckoutSessionId: string | null;
  stripeSetupIntentId: string | null;
  stripeSetupIntentStatus: string | null;
  stripeDefaultPaymentMethodId: string | null;
  paymentMethodUpdatedAt: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  activatedAt: string | null;
  firstPaidAt: string | null;
  guaranteeEndsAt: string | null;
  billingAttentionSince: string | null;
  billingUpdatedAt: string | null;
  canceledAt: string | null;
  onboardingStatusUpdatedAt: string | null;
  setupFeeCents: number;
  setupFeeStatus: "due" | "paid" | "waived" | "partially_refunded" | "refunded" | "disputed" | "charged_back";
  setupFeeCheckoutSessionId: string | null;
  setupFeePaymentIntentId: string | null;
  setupFeePaidAt: string | null;
  setupFeeWaivedAt: string | null;
  setupFeeWaiverReason: string | null;
  setupFeeRefundedAt: string | null;
  setupFeeRefundedCents: number;
  setupFeeDisputeStatus: string | null;
  monthlyPriceCents: number;
};

export type BillingLifecycleState = {
  activationReady: boolean;
  billingStatus: AccountBillingStatus;
  onboardingStatus: AccountOnboardingStatus;
  ownerAction: BillingOwnerAction;
  label: string;
  headline: string;
  summary: string;
  tone: "good" | "warn" | "neutral";
};

export type BillingCheckoutEligibility =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "already_active"
        | "subscription_incomplete"
        | "past_due"
        | "setup_incomplete"
        | "initial_trial_managed_automatically"
        | "contact_support";
    };

export type OperatorBillingOverrideAction =
  | "comp"
  | "uncomp"
  | "waive_setup_fee"
  | "require_setup_fee";

const DEFAULT_BILLING_RECORD: AccountBillingRecord = {
  billingStatus: "not_started",
  billingPolicy: "standard",
  commercialOffer: "standard",
  onboardingStatus: "setting_up",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  stripePriceId: null,
  stripeSubscriptionStatus: null,
  billingSetupCheckoutSessionId: null,
  stripeSetupIntentId: null,
  stripeSetupIntentStatus: null,
  stripeDefaultPaymentMethodId: null,
  paymentMethodUpdatedAt: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  activatedAt: null,
  firstPaidAt: null,
  guaranteeEndsAt: null,
  billingAttentionSince: null,
  billingUpdatedAt: null,
  canceledAt: null,
  onboardingStatusUpdatedAt: null,
  setupFeeCents: 15000,
  // Missing billing data must never invent an unaudited waiver.
  setupFeeStatus: "due",
  setupFeeCheckoutSessionId: null,
  setupFeePaymentIntentId: null,
  setupFeePaidAt: null,
  setupFeeWaivedAt: null,
  setupFeeWaiverReason: null,
  setupFeeRefundedAt: null,
  setupFeeRefundedCents: 0,
  setupFeeDisputeStatus: null,
  monthlyPriceCents: 9900,
};

export function defaultBillingRecord(): AccountBillingRecord {
  return { ...DEFAULT_BILLING_RECORD };
}

export function isSetupFeeSettled(
  status: AccountBillingRecord["setupFeeStatus"] | null | undefined,
  firstPaidAt?: string | null,
  policy: BillingPolicy = "standard",
) {
  if (policy === "setup_fee_waived" || policy === "comped") {
    return true;
  }
  // An explicit current Stripe state wins over historical payment facts. A
  // fully refunded, disputed, or charged-back fee must not remain settled just
  // because it was paid once. Older pre-commercial rows with no setup-fee
  // field still preserve their prior paid-activation behavior.
  if (status != null) {
    return status === "paid" || status === "waived" || status === "partially_refunded";
  }

  return Boolean(firstPaidAt) || status == null;
}

export function normalizeBillingStatus(value: string | null | undefined): AccountBillingStatus {
  if (
    value === "not_started" ||
    value === "trialing" ||
    value === "active" ||
    value === "past_due" ||
    value === "canceled" ||
    value === "comped"
  ) {
    return value;
  }

  return "not_started";
}

export function normalizeBillingPolicy(
  value: string | null | undefined,
  legacy?: Pick<AccountBillingRecord, "billingStatus" | "setupFeeStatus">,
): BillingPolicy {
  if (value === "standard" || value === "setup_fee_waived" || value === "comped") {
    return value;
  }
  if (legacy?.billingStatus === "comped") return "comped";
  if (legacy?.setupFeeStatus === "waived") return "setup_fee_waived";
  return "standard";
}

export function normalizeCommercialOffer(value: string | null | undefined): CommercialOffer {
  return value === "founding_pilot" ? "founding_pilot" : "standard";
}

export function normalizeOnboardingStatus(value: string | null | undefined): AccountOnboardingStatus {
  if (
    value === "setting_up" ||
    value === "waiting_for_forwarding" ||
    value === "live" ||
    value === "paused" ||
    value === "closed"
  ) {
    return value;
  }
  if (value === "paused_incomplete") return "paused";
  if (value === "closed_incomplete") return "closed";
  if (value === "activated" || value === "ready_to_activate") return "live";
  if (value === "waiting_on_customer") return "waiting_for_forwarding";

  return "setting_up";
}

export function normalizeStripeSubscriptionStatus(value: string | null | undefined): StripeSubscriptionStatus | null {
  if (
    value === "incomplete" ||
    value === "incomplete_expired" ||
    value === "trialing" ||
    value === "active" ||
    value === "past_due" ||
    value === "canceled" ||
    value === "unpaid" ||
    value === "paused"
  ) {
    return value;
  }

  return null;
}

function formatBillingLifecycleDate(value: string | null) {
  if (!value) return null;

  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function actionFor(input: {
  billingStatus: AccountBillingStatus;
  activationReady: boolean;
  setupFeeSettled: boolean;
  paymentMethodReady: boolean;
}): BillingOwnerAction {
  if (input.billingStatus === "comped") {
    return "none";
  }

  if (input.billingStatus === "active" || input.billingStatus === "trialing") {
    return "manage_billing";
  }

  if (input.billingStatus === "past_due") {
    return "update_payment";
  }

  if (input.billingStatus === "canceled") {
    return input.activationReady ? "restart_subscription" : "finish_setup";
  }

  if (!input.setupFeeSettled) {
    return "pay_setup_fee";
  }

  if (!input.paymentMethodReady) {
    return "add_payment_method";
  }

  if (!input.activationReady) {
    return "finish_setup";
  }

  return "wait_for_activation";
}

export function computeBillingLifecycle(input: {
  billing: AccountBillingRecord | null | undefined;
  technicalStatus: TechnicalSetupStatus;
  a2pStatus: A2pRegistrationStatus;
  smsEnabled: boolean;
}): BillingLifecycleState {
  const billing = input.billing ?? defaultBillingRecord();
  const activationReady = canStartMonthlyTrial({
    technicalStatus: input.technicalStatus,
    a2pStatus: input.a2pStatus,
    smsEnabled: input.smsEnabled,
    blockedBy: "none",
  });
  const billingStatus = billing.billingPolicy === "comped"
    ? "comped"
    : normalizeBillingStatus(billing.billingStatus);
  const onboardingStatus = input.technicalStatus;
  const setupFeeSettled = isSetupFeeSettled(
    billing.setupFeeStatus,
    billing.firstPaidAt,
    billing.billingPolicy,
  );
  const paymentMethodReady = Boolean(billing.stripeDefaultPaymentMethodId);
  const ownerAction = actionFor({
    billingStatus,
    activationReady,
    setupFeeSettled,
    paymentMethodReady,
  });
  if (billingStatus === "past_due") {
    return {
      activationReady,
      billingStatus,
      onboardingStatus,
      ownerAction,
      label: "Payment needs attention",
      headline: "Billing needs attention.",
      summary: "Update payment in Stripe so the subscription stays in good standing. Missed-call capture keeps working while billing is resolved.",
      tone: "warn",
    };
  }

  if (billingStatus === "canceled") {
    return {
      activationReady,
      billingStatus,
      onboardingStatus,
      ownerAction,
      label: "Canceled",
      headline: "Subscription is canceled.",
      summary: activationReady
        ? "Restart securely in Stripe. Your original free trial will not repeat."
        : "Finish automatic text-back setup before restarting billing.",
      tone: "warn",
    };
  }

  if (billingStatus === "active" || billingStatus === "trialing" || billingStatus === "comped") {
    const scheduledToCancel = billing.cancelAtPeriodEnd && billingStatus !== "comped";
    const trialEndsAt = formatBillingLifecycleDate(billing.trialEndsAt);

    return {
      activationReady,
      billingStatus,
      onboardingStatus,
      ownerAction,
      label: scheduledToCancel ? "Active until end date" : billingStatus === "comped" ? "Comped" : billingStatus === "trialing" ? "Trial active" : "Active",
      headline: scheduledToCancel
        ? "Subscription is scheduled to end."
        : billingStatus === "comped"
          ? "Billing is comped."
          : billingStatus === "trialing"
            ? "Trial is active."
            : "Billing is active.",
      summary: scheduledToCancel
        ? "Your subscription has been canceled. Relay keeps catching missed calls until the current billing period ends."
        : billingStatus === "comped"
          ? "Relay is intentionally not charging this account."
          : billingStatus === "trialing"
            ? trialEndsAt
              ? `Your trial is active until ${trialEndsAt}.`
              : "Your trial is active."
            : "Your subscription is active and will renew monthly unless canceled.",
      tone: scheduledToCancel ? "warn" : billingStatus === "comped" ? "neutral" : "good",
    };
  }

  if (!setupFeeSettled) {
    return {
      activationReady,
      billingStatus,
      onboardingStatus,
      ownerAction,
      label: "Setup fee due",
      headline: "Complete the one-time setup payment.",
      summary: "The $150 payment saves your card securely in Stripe. Your monthly trial still waits for automatic text-back.",
      tone: "neutral",
    };
  }

  if (!paymentMethodReady) {
    const terms = commercialTermsForOffer(billing.commercialOffer);
    return {
      activationReady,
      billingStatus,
      onboardingStatus,
      ownerAction,
      label: "Card needed",
      headline: "Add a payment method securely.",
      summary: `Stripe will save the card for $99/month after the ${terms.trialDays}-day trial. Nothing is charged now.`,
      tone: "neutral",
    };
  }

  if (activationReady) {
    return {
      activationReady,
      billingStatus,
      onboardingStatus,
      ownerAction,
      label: "Activating trial",
      headline: "Automatic text-back is ready.",
      summary: `Relay will start the Stripe-owned ${commercialTermsForOffer(billing.commercialOffer).trialDays}-day trial automatically.`,
      tone: "good",
    };
  }

  return {
    activationReady,
    billingStatus,
    onboardingStatus,
    ownerAction,
    label: "Setup first",
    headline: "Monthly billing is waiting.",
    summary: "The trial begins only after A2P approval and automatic text-back activation.",
    tone: "neutral",
  };
}

export function getBillingCheckoutEligibility(input: {
  billing: AccountBillingRecord | null | undefined;
  activationReady: boolean;
}): BillingCheckoutEligibility {
  const billing = input.billing ?? defaultBillingRecord();
  const billingStatus = normalizeBillingStatus(billing.billingStatus);
  const stripeStatus = normalizeStripeSubscriptionStatus(billing.stripeSubscriptionStatus);

  if (billing.billingPolicy === "comped") {
    return { ok: false, reason: "already_active" };
  }

  if (
    billingStatus === "active" ||
    billingStatus === "trialing" ||
    stripeStatus === "active" ||
    stripeStatus === "trialing"
  ) {
    return { ok: false, reason: "already_active" };
  }

  if (
    billingStatus === "past_due" ||
    stripeStatus === "past_due" ||
    stripeStatus === "unpaid" ||
    stripeStatus === "paused"
  ) {
    return { ok: false, reason: "past_due" };
  }

  if (stripeStatus === "incomplete") {
    return { ok: false, reason: "subscription_incomplete" };
  }

  // Initial subscriptions are created automatically only after full text-back
  // activation. Checkout remains an on-session, authenticated restart path
  // after a customer has already used the initial trial.
  if (
    billingStatus === "canceled" &&
    (stripeStatus === "canceled" || stripeStatus === "incomplete_expired" || !stripeStatus) &&
    Boolean(billing.activatedAt || billing.firstPaidAt || billing.canceledAt)
  ) {
    return input.activationReady
      ? { ok: true }
      : { ok: false, reason: "setup_incomplete" };
  }

  if (billingStatus === "not_started") {
    return { ok: false, reason: "initial_trial_managed_automatically" };
  }

  return { ok: false, reason: "contact_support" };
}

export function canApplyOperatorBillingOverride(
  billing: Pick<AccountBillingRecord, "stripeSubscriptionId" | "stripeSubscriptionStatus"> | null | undefined,
) {
  if (!billing?.stripeSubscriptionId) {
    return true;
  }

  const stripeStatus = normalizeStripeSubscriptionStatus(billing.stripeSubscriptionStatus);
  return stripeStatus === "canceled" || stripeStatus === "incomplete_expired";
}
