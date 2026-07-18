import type { SetupReadiness } from "@/lib/readiness";

export type AccountBillingStatus = "not_started" | "trialing" | "active" | "past_due" | "canceled" | "comped";

export type AccountOnboardingStatus =
  | "requirements_needed"
  | "waiting_on_customer"
  | "carrier_review"
  | "carrier_attention"
  | "ready_for_live_test"
  | "ready_to_activate"
  | "activated"
  | "paused_incomplete"
  | "closed_incomplete";

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
  onboardingStatus: AccountOnboardingStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  stripeSubscriptionStatus: StripeSubscriptionStatus | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  requirementsDueAt: string | null;
  activatedAt: string | null;
  firstPaidAt: string | null;
  guaranteeEndsAt: string | null;
  billingAttentionSince: string | null;
  billingUpdatedAt: string | null;
  canceledAt: string | null;
  onboardingStatusUpdatedAt: string | null;
  setupFeeCents: number;
  setupFeeStatus: "due" | "paid" | "waived" | "refunded";
  setupFeeCheckoutSessionId: string | null;
  setupFeePaymentIntentId: string | null;
  setupFeePaidAt: string | null;
  setupFeeWaivedAt: string | null;
  setupFeeWaiverReason: string | null;
  monthlyPriceCents: number;
};

export type BillingOperatingState =
  | "setup_not_billable"
  | "ready_to_start_billing"
  | "trialing"
  | "active"
  | "comped"
  | "billing_attention";

export type BillingReadiness = {
  state: BillingOperatingState;
  activationReady: boolean;
  billingStatus: AccountBillingStatus;
  onboardingStatus: AccountOnboardingStatus;
  ownerAction: BillingOwnerAction;
  label: string;
  headline: string;
  summary: string;
  tone: "good" | "warn" | "neutral";
};

export type BillingLifecycleState = {
  activationReady: boolean;
  billingStatus: AccountBillingStatus;
  onboardingStatus: AccountOnboardingStatus;
  ownerAction: BillingOwnerAction;
  customerDelay: boolean;
  carrierDelay: boolean;
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
  | "grant_trial"
  | "extend_trial"
  | "end_trial_now"
  | "waive_setup_fee"
  | "require_setup_fee";

export const BILLING_TRIAL_EXPIRY_ACTION = "billing.trial.expired";

const DEFAULT_BILLING_RECORD: AccountBillingRecord = {
  billingStatus: "not_started",
  onboardingStatus: "requirements_needed",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  stripePriceId: null,
  stripeSubscriptionStatus: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  requirementsDueAt: null,
  activatedAt: null,
  firstPaidAt: null,
  guaranteeEndsAt: null,
  billingAttentionSince: null,
  billingUpdatedAt: null,
  canceledAt: null,
  onboardingStatusUpdatedAt: null,
  setupFeeCents: 15000,
  // Missing commercial columns degrade to the pre-commercial pilot behavior.
  setupFeeStatus: "waived",
  setupFeeCheckoutSessionId: null,
  setupFeePaymentIntentId: null,
  setupFeePaidAt: null,
  setupFeeWaivedAt: null,
  setupFeeWaiverReason: null,
  monthlyPriceCents: 9900,
};

export function defaultBillingRecord(): AccountBillingRecord {
  return { ...DEFAULT_BILLING_RECORD };
}

export function isSetupFeeSettled(
  status: AccountBillingRecord["setupFeeStatus"] | null | undefined,
  firstPaidAt?: string | null,
) {
  // Older callers and pre-commercial rows have no setup-fee field; preserve
  // their explicit pilot behavior. A prior paid activation also proves that
  // this one-time fee was already settled and must not be charged again.
  return Boolean(firstPaidAt) || status == null || status === "paid" || status === "waived";
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

export function normalizeOnboardingStatus(value: string | null | undefined): AccountOnboardingStatus {
  if (
    value === "requirements_needed" ||
    value === "waiting_on_customer" ||
    value === "carrier_review" ||
    value === "carrier_attention" ||
    value === "ready_for_live_test" ||
    value === "ready_to_activate" ||
    value === "activated" ||
    value === "paused_incomplete" ||
    value === "closed_incomplete"
  ) {
    return value;
  }

  return "requirements_needed";
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

export function isBillingActivationReady(readiness: Pick<SetupReadiness, "callCaptureReady" | "smsRegistrationReady">) {
  return readiness.callCaptureReady && readiness.smsRegistrationReady;
}

function formatBillingLifecycleDate(value: string | null) {
  if (!value) return null;

  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function trialSummary(trialEndsAt: string | null) {
  if (!trialEndsAt) {
    return "Billing is in trial mode. Relay should keep working while the subscription is checked.";
  }

  return `Trial is active until ${formatBillingLifecycleDate(trialEndsAt)}.`;
}

export function computeBillingReadiness(input: {
  billing: AccountBillingRecord | null | undefined;
  setupReadiness: Pick<SetupReadiness, "callCaptureReady" | "smsRegistrationReady">;
}): BillingReadiness {
  const lifecycle = computeBillingLifecycle(input);
  const billing = input.billing ?? defaultBillingRecord();
  const billingStatus = normalizeBillingStatus(billing.billingStatus);

  if (billingStatus === "active") {
    if (billing.cancelAtPeriodEnd) {
      const periodEnd = formatBillingLifecycleDate(billing.currentPeriodEnd);

      return {
        state: "active",
        activationReady: lifecycle.activationReady,
        billingStatus,
        onboardingStatus: lifecycle.onboardingStatus,
        ownerAction: lifecycle.ownerAction,
        label: periodEnd ? `Active until ${periodEnd}` : "Active until period end",
        headline: "Subscription has been canceled.",
        summary: periodEnd
          ? `Relay keeps working until ${periodEnd}.`
          : "Relay keeps working until the current billing period ends.",
        tone: "warn",
      };
    }

    return {
      state: "active",
      activationReady: lifecycle.activationReady,
      billingStatus,
      onboardingStatus: lifecycle.onboardingStatus,
      ownerAction: lifecycle.ownerAction,
      label: "Billing active",
      headline: "Subscription is active.",
      summary: "This account has an active billing record.",
      tone: "good",
    };
  }

  if (billingStatus === "comped") {
    return {
      state: "comped",
      activationReady: lifecycle.activationReady,
      billingStatus,
      onboardingStatus: lifecycle.onboardingStatus,
      ownerAction: lifecycle.ownerAction,
      label: "Comped",
      headline: "Billing is comped.",
      summary: "Relay is intentionally not charging this account.",
      tone: "neutral",
    };
  }

  if (billingStatus === "trialing") {
    return {
      state: "trialing",
      activationReady: lifecycle.activationReady,
      billingStatus,
      onboardingStatus: lifecycle.onboardingStatus,
      ownerAction: lifecycle.ownerAction,
      label: "Trial",
      headline: "Trial is active.",
      summary: trialSummary(billing.trialEndsAt),
      tone: "good",
    };
  }

  if (billingStatus === "past_due" || billingStatus === "canceled") {
    return {
      state: "billing_attention",
      activationReady: lifecycle.activationReady,
      billingStatus,
      onboardingStatus: lifecycle.onboardingStatus,
      ownerAction: lifecycle.ownerAction,
      label: billingStatus === "past_due" ? "Past due" : "Canceled",
      headline: billingStatus === "past_due" ? "Billing needs attention." : "Subscription is canceled.",
      summary: "Do not automatically disable missed-call capture in Phase 5A; resolve billing before scaling enforcement.",
      tone: "warn",
    };
  }

  if (!isSetupFeeSettled(billing.setupFeeStatus, billing.firstPaidAt)) {
    return {
      state: "setup_not_billable",
      activationReady: lifecycle.activationReady,
      billingStatus,
      onboardingStatus: lifecycle.onboardingStatus,
      ownerAction: "pay_setup_fee",
      label: "Setup fee due",
      headline: "Start with the setup fee.",
      summary: "Pay the one-time setup fee so Relay can finish configuring this account. Monthly billing starts only after carrier approval and activation.",
      tone: "warn",
    };
  }

  if (lifecycle.activationReady) {
    return {
      state: "ready_to_start_billing",
      activationReady: lifecycle.activationReady,
      billingStatus,
      onboardingStatus: lifecycle.onboardingStatus,
      ownerAction: lifecycle.ownerAction,
      label: "Ready to bill",
      headline: "Relay is ready for activation billing.",
      summary: "Call capture and carrier texting are ready. Start billing when the customer is handed off.",
      tone: "warn",
    };
  }

  return {
    state: "setup_not_billable",
    activationReady: lifecycle.activationReady,
    billingStatus,
    onboardingStatus: lifecycle.onboardingStatus,
    ownerAction: lifecycle.ownerAction,
    label: "Setup first",
    headline: "Billing should wait.",
    summary: "Finish call capture and carrier texting approval before charging this account.",
    tone: "neutral",
  };
}

export function deriveEffectiveOnboardingStatus(input: {
  billing: Pick<AccountBillingRecord, "onboardingStatus" | "billingStatus" | "activatedAt" | "firstPaidAt">;
  activationReady: boolean;
}): AccountOnboardingStatus {
  const current = normalizeOnboardingStatus(input.billing.onboardingStatus);
  const billingStatus = normalizeBillingStatus(input.billing.billingStatus);

  if (
    current === "activated" ||
    input.billing.activatedAt ||
    input.billing.firstPaidAt ||
    billingStatus === "active" ||
    billingStatus === "trialing" ||
    billingStatus === "comped"
  ) {
    return "activated";
  }

  if (current === "paused_incomplete" || current === "closed_incomplete") {
    return current;
  }

  if (input.activationReady) {
    return "ready_to_activate";
  }

  return current;
}

function actionFor(input: {
  billingStatus: AccountBillingStatus;
  onboardingStatus: AccountOnboardingStatus;
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

  if (
    !isSetupFeeSettled(input.setupFeeStatus, input.firstPaidAt) &&
    input.billingStatus !== "active" &&
    input.billingStatus !== "trialing" &&
    input.billingStatus !== "past_due"
  ) {
    return "pay_setup_fee";
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

  if (input.onboardingStatus === "carrier_attention") {
    return "contact_support";
  }

  if (input.onboardingStatus === "closed_incomplete") {
    return "contact_support";
  }

  if (!input.activationReady) {
    return "finish_setup";
  }

  return "start_billing";
}

export function computeBillingLifecycle(input: {
  billing: AccountBillingRecord | null | undefined;
  setupReadiness: Pick<SetupReadiness, "callCaptureReady" | "smsRegistrationReady">;
}): BillingLifecycleState {
  const billing = input.billing ?? defaultBillingRecord();
  const activationReady = isBillingActivationReady(input.setupReadiness);
  const billingStatus = normalizeBillingStatus(billing.billingStatus);
  const onboardingStatus = deriveEffectiveOnboardingStatus({ billing, activationReady });
  const ownerAction = actionFor({
    billingStatus,
    onboardingStatus,
    activationReady,
    stripeSubscriptionId: billing.stripeSubscriptionId,
    trialEndsAt: billing.trialEndsAt,
    cancelAtPeriodEnd: billing.cancelAtPeriodEnd,
    setupFeeStatus: billing.setupFeeStatus,
    firstPaidAt: billing.firstPaidAt,
  });
  const customerDelay =
    onboardingStatus === "requirements_needed" ||
    onboardingStatus === "waiting_on_customer" ||
    onboardingStatus === "paused_incomplete" ||
    onboardingStatus === "closed_incomplete";
  const carrierDelay = onboardingStatus === "carrier_review" || onboardingStatus === "carrier_attention";

  if (billingStatus === "past_due") {
    const expiredAppTrial = !billing.stripeSubscriptionId && billing.trialEndsAt;

    return {
      activationReady,
      billingStatus,
      onboardingStatus,
      ownerAction,
      customerDelay,
      carrierDelay,
      label: expiredAppTrial ? "Trial ended" : "Payment needs attention",
      headline: expiredAppTrial ? "Trial ended." : "Billing needs attention.",
      summary: expiredAppTrial
        ? "Start billing to move this account onto a paid subscription. Missed-call capture keeps working while billing is resolved."
        : "Update payment so the subscription stays in good standing. Missed-call capture should keep working while billing is resolved.",
      tone: "warn",
    };
  }

  if (billingStatus === "canceled") {
    return {
      activationReady,
      billingStatus,
      onboardingStatus,
      ownerAction,
      customerDelay,
      carrierDelay,
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
      customerDelay,
      carrierDelay,
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

  if (!isSetupFeeSettled(billing.setupFeeStatus, billing.firstPaidAt)) {
    return {
      activationReady,
      billingStatus,
      onboardingStatus,
      ownerAction,
      customerDelay,
      carrierDelay,
      label: "Setup fee due",
      headline: "Start with the setup fee.",
      summary: "Pay the one-time setup fee so Relay can finish configuring this account. Monthly billing starts only after carrier approval and activation.",
      tone: "warn",
    };
  }

  if (activationReady) {
    return {
      activationReady,
      billingStatus,
      onboardingStatus,
      ownerAction,
      customerDelay,
      carrierDelay,
      label: "Ready to bill",
      headline: "Ready for activation billing.",
      summary: "Call capture and carrier texting are ready. Start billing when the customer is handed off.",
      tone: "warn",
    };
  }

  return {
    activationReady,
    billingStatus,
    onboardingStatus,
    ownerAction,
    customerDelay,
    carrierDelay,
    label: customerDelay ? "Waiting on customer" : carrierDelay ? "Carrier review" : "Setup first",
    headline: "Billing should wait.",
    summary: carrierDelay
      ? "Carrier registration is still moving. Do not start monthly billing until activation is ready."
      : "Finish setup before charging this account.",
    tone: "neutral",
  };
}

export function getBillingCheckoutEligibility(input: {
  billing: AccountBillingRecord | null | undefined;
  setupReadiness: Pick<SetupReadiness, "callCaptureReady" | "smsRegistrationReady">;
}): BillingCheckoutEligibility {
  const billing = input.billing ?? defaultBillingRecord();
  const activationReady = isBillingActivationReady(input.setupReadiness);
  const billingStatus = normalizeBillingStatus(billing.billingStatus);
  const stripeStatus = normalizeStripeSubscriptionStatus(billing.stripeSubscriptionStatus);

  if (!activationReady) {
    return { ok: false, reason: "setup_incomplete" };
  }

  if (!isSetupFeeSettled(billing.setupFeeStatus, billing.firstPaidAt)) {
    return { ok: false, reason: "setup_fee_required" };
  }

  if (billingStatus === "active" || stripeStatus === "active" || stripeStatus === "trialing") {
    return { ok: false, reason: "already_active" };
  }

  if (billingStatus === "past_due" || stripeStatus === "past_due" || stripeStatus === "unpaid") {
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
    if (!stripeStatus || stripeStatus === "canceled" || stripeStatus === "incomplete_expired") {
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

export function normalizeOperatorTrialDays(value: number | string | null | undefined, fallback = 30) {
  const numeric = typeof value === "number" ? value : Number(value);
  const days = Number.isFinite(numeric) ? Math.round(numeric) : fallback;

  return Math.min(90, Math.max(7, days));
}

export function addTrialDays(input: {
  trialEndsAt?: string | null;
  days: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const existing = input.trialEndsAt ? new Date(input.trialEndsAt) : null;
  const base = existing && Number.isFinite(existing.getTime()) && existing > now ? existing : now;

  return new Date(base.getTime() + input.days * 24 * 60 * 60 * 1000).toISOString();
}

export function chooseBillingTrialExpiryAction(input: {
  billingStatus: string | null | undefined;
  stripeSubscriptionId?: string | null;
  trialEndsAt?: string | null;
  completedActions?: Set<string>;
  now?: Date;
}) {
  const billingStatus = normalizeBillingStatus(input.billingStatus);

  if (billingStatus !== "trialing" || input.stripeSubscriptionId) {
    return "none" as const;
  }

  if (input.completedActions?.has(BILLING_TRIAL_EXPIRY_ACTION)) {
    return "none" as const;
  }

  if (!input.trialEndsAt) {
    return "none" as const;
  }

  const trialEnd = new Date(input.trialEndsAt);
  if (!Number.isFinite(trialEnd.getTime())) {
    return "none" as const;
  }

  const now = input.now ?? new Date();
  return trialEnd <= now ? "expire_app_trial" as const : "none" as const;
}
