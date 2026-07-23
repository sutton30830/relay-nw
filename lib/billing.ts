import {
  canStartMonthlyBilling,
  type BillingPolicy,
  type TechnicalSetupStatus,
} from "@/lib/customer-experience-contract";

export type { BillingPolicy } from "@/lib/customer-experience-contract";

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
  | "finish_setup"
  | "start_billing"
  | "manage_billing"
  | "update_payment"
  | "restart_subscription"
  | "contact_support";

export type AccountBillingRecord = {
  billingStatus: AccountBillingStatus;
  billingPolicy: BillingPolicy;
  onboardingStatus: AccountOnboardingStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  stripeSubscriptionStatus: StripeSubscriptionStatus | null;
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
        | "setup_incomplete"
        | "setup_fee_required"
        | "already_active"
        | "subscription_incomplete"
        | "past_due"
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
  onboardingStatus: "setting_up",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  stripePriceId: null,
  stripeSubscriptionStatus: null,
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
  stripeSubscriptionId?: string | null;
  trialEndsAt?: string | null;
  cancelAtPeriodEnd?: boolean;
  setupFeeStatus?: AccountBillingRecord["setupFeeStatus"];
  firstPaidAt?: string | null;
}): BillingOwnerAction {
  if (input.billingStatus === "comped") {
    return "none";
  }

  if (input.billingStatus === "active" || input.billingStatus === "trialing") {
    return "manage_billing";
  }

  if (input.billingStatus === "past_due") {
    if (!input.stripeSubscriptionId && input.trialEndsAt) {
      return input.activationReady ? "start_billing" : "finish_setup";
    }

    return "update_payment";
  }

  if (input.billingStatus === "canceled") {
    return input.activationReady ? "restart_subscription" : "finish_setup";
  }

  if (!input.activationReady) {
    return "finish_setup";
  }

  return "start_billing";
}

export function computeBillingLifecycle(input: {
  billing: AccountBillingRecord | null | undefined;
  technicalStatus: TechnicalSetupStatus;
}): BillingLifecycleState {
  const billing = input.billing ?? defaultBillingRecord();
  const activationReady = canStartMonthlyBilling(input.technicalStatus);
  const billingStatus = billing.billingPolicy === "comped"
    ? "comped"
    : normalizeBillingStatus(billing.billingStatus);
  const onboardingStatus = input.technicalStatus;
  const ownerAction = actionFor({
    billingStatus,
    activationReady,
    stripeSubscriptionId: billing.stripeSubscriptionId,
    trialEndsAt: billing.trialEndsAt,
    cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
    setupFeeStatus: billing.setupFeeStatus,
    firstPaidAt: billing.firstPaidAt,
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
        ? "Relay is still configured. Restart the subscription before treating this account as paid."
        : "Finish setup before restarting billing.",
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

  if (activationReady) {
    return {
      activationReady,
      billingStatus,
      onboardingStatus,
      ownerAction,
      label: "Ready to bill",
      headline: "Ready for activation billing.",
      summary: "Call capture is live. Start billing when the customer is handed off.",
      tone: "warn",
    };
  }

  return {
    activationReady,
    billingStatus,
    onboardingStatus,
    ownerAction,
    label: "Setup first",
    headline: "Billing should wait.",
    summary: "Finish call capture before charging this account.",
    tone: "neutral",
  };
}

export function getBillingCheckoutEligibility(input: {
  billing: AccountBillingRecord | null | undefined;
  technicalStatus: TechnicalSetupStatus;
}): BillingCheckoutEligibility {
  const billing = input.billing ?? defaultBillingRecord();
  const activationReady = canStartMonthlyBilling(input.technicalStatus);
  const billingStatus = normalizeBillingStatus(billing.billingStatus);
  const stripeStatus = normalizeStripeSubscriptionStatus(billing.stripeSubscriptionStatus);

  if (!activationReady) {
    return { ok: false, reason: "setup_incomplete" };
  }

  if (billing.billingPolicy === "comped") {
    return { ok: false, reason: "already_active" };
  }

  if (billingStatus === "active" || stripeStatus === "active" || stripeStatus === "trialing") {
    return { ok: false, reason: "already_active" };
  }

  if (stripeStatus === "incomplete_expired" || stripeStatus === "canceled") {
    return { ok: true };
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

  if (billingStatus === "not_started") {
    return { ok: true };
  }

  if (billingStatus === "trialing" && !billing.stripeSubscriptionId) {
    return { ok: true };
  }

  if (billingStatus === "canceled") {
    if (!stripeStatus) {
      return { ok: true };
    }

    return { ok: false, reason: "contact_support" };
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
