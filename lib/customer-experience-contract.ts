// Shared contract for the simplified customer experience.

export const TECHNICAL_SETUP_STATUSES = [
  "setting_up",
  "waiting_for_forwarding",
  "live",
  "paused",
  "closed",
] as const;

export type TechnicalSetupStatus = (typeof TECHNICAL_SETUP_STATUSES)[number];

export const A2P_REGISTRATION_STATUSES = [
  "not_started",
  "in_progress",
  "approved",
  "needs_attention",
  "rejected",
  "paused",
] as const;

export type A2pRegistrationStatus = (typeof A2P_REGISTRATION_STATUSES)[number];

export const BILLING_POLICIES = ["standard", "setup_fee_waived", "comped"] as const;

export type BillingPolicy = (typeof BILLING_POLICIES)[number];

export const SETUP_FEE_PAYMENT_STATUSES = [
  "not_started",
  "processing",
  "paid",
  "partially_refunded",
  "refunded",
  "disputed",
  "charged_back",
] as const;

export type SetupFeePaymentStatus = (typeof SETUP_FEE_PAYMENT_STATUSES)[number];

export const STRIPE_SUBSCRIPTION_STATUSES = [
  "not_started",
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "canceled",
  "paused",
] as const;

export type StripeSubscriptionStatus = (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];

export const COMMERCIAL_OFFERS = ["standard", "founding_pilot"] as const;

export type CommercialOffer = (typeof COMMERCIAL_OFFERS)[number];

export const OPERATIONS_BLOCKERS = ["none", "relay", "customer", "carrier"] as const;

export type OperationsBlocker = (typeof OPERATIONS_BLOCKERS)[number];

export const STANDARD_TRIAL_DAYS = 14;
export const FOUNDING_PILOT_TRIAL_DAYS = 30;
export const STANDARD_SETUP_FEE_CENTS = 15_000;

export type SetupFeeTreatment = "required" | "waived";

export type CommercialTerms = {
  setupFeeCents: number;
  setupFeeTreatment: SetupFeeTreatment;
  trialDays: number;
};

export function commercialTermsForOffer(offer: CommercialOffer): CommercialTerms {
  if (offer === "founding_pilot") {
    return {
      setupFeeCents: STANDARD_SETUP_FEE_CENTS,
      setupFeeTreatment: "waived",
      trialDays: FOUNDING_PILOT_TRIAL_DAYS,
    };
  }

  return {
    setupFeeCents: STANDARD_SETUP_FEE_CENTS,
    setupFeeTreatment: "required",
    trialDays: STANDARD_TRIAL_DAYS,
  };
}

export function isAutomaticTextBackActive(input: {
  technicalStatus: TechnicalSetupStatus;
  a2pStatus: A2pRegistrationStatus;
  smsEnabled: boolean;
}) {
  return (
    input.technicalStatus === "live" &&
    input.a2pStatus === "approved" &&
    input.smsEnabled
  );
}

// A Stripe-owned trial starts only when the paid outcome is working and nobody
// is still blocking activation. Call capture by itself remains useful
// technical progress, but is not the $99 activation bar.
export function canStartMonthlyTrial(input: {
  technicalStatus: TechnicalSetupStatus;
  a2pStatus: A2pRegistrationStatus;
  smsEnabled: boolean;
  blockedBy: OperationsBlocker;
}) {
  return input.blockedBy === "none" && isAutomaticTextBackActive(input);
}

export const BILLING_FACT_AUTHORITIES = {
  payment_method: "stripe",
  setup_fee_payment: "stripe",
  subscription: "stripe",
  trial: "stripe",
  invoice: "stripe",
  refund: "stripe",
  dispute: "stripe",
  retry: "stripe",
  cancellation: "stripe",
  setup_fee_waiver: "relay",
  comped_service: "relay",
  technical_setup: "relay",
  operations_blocker: "relay",
} as const;

export type BillingFact = keyof typeof BILLING_FACT_AUTHORITIES;
export type BillingFactAuthority = (typeof BILLING_FACT_AUTHORITIES)[BillingFact];

export function authorityForBillingFact(fact: BillingFact): BillingFactAuthority {
  return BILLING_FACT_AUTHORITIES[fact];
}

export type CustomerSetupView =
  | "relay_setting_up"
  | "forwarding_action_required"
  | "calls_live_texting_pending"
  | "calls_live_texting_available"
  | "calls_live_texting_on"
  | "service_paused"
  | "account_closed";

export function deriveCustomerSetupView(input: {
  technicalStatus: TechnicalSetupStatus;
  a2pStatus: A2pRegistrationStatus;
  smsEnabled: boolean;
}): CustomerSetupView {
  if (input.technicalStatus === "closed") return "account_closed";
  if (input.technicalStatus === "paused") return "service_paused";
  if (input.technicalStatus === "setting_up") return "relay_setting_up";
  if (input.technicalStatus === "waiting_for_forwarding") return "forwarding_action_required";
  if (input.a2pStatus !== "approved") return "calls_live_texting_pending";
  return input.smsEnabled ? "calls_live_texting_on" : "calls_live_texting_available";
}

// A real missed call is the Phase 1 completion signal. Billing and A2P are
// deliberately absent from this decision.
export function shouldMarkTechnicalSetupLive(input: {
  technicalStatus: TechnicalSetupStatus;
  insertedNewMissedCall: boolean;
  twilioSignatureValid: boolean;
}) {
  return (
    (input.technicalStatus === "setting_up" || input.technicalStatus === "waiting_for_forwarding") &&
    input.insertedNewMissedCall &&
    input.twilioSignatureValid
  );
}

export function canEnableAutomaticTexting(a2pStatus: A2pRegistrationStatus) {
  return a2pStatus === "approved";
}

export function setupFeeIsCommerciallySettled(input: {
  policy: BillingPolicy;
  paymentStatus: SetupFeePaymentStatus;
}) {
  return (
    input.policy === "setup_fee_waived" ||
    input.policy === "comped" ||
    input.paymentStatus === "paid" ||
    input.paymentStatus === "partially_refunded"
  );
}

export type CustomerBillingView =
  | "comped"
  | "not_started"
  | "checkout_incomplete"
  | "trialing"
  | "active"
  | "canceling"
  | "payment_attention"
  | "canceled";

export function deriveCustomerBillingView(input: {
  policy: BillingPolicy;
  stripeSubscriptionStatus: StripeSubscriptionStatus;
  cancelAtPeriodEnd: boolean;
}): CustomerBillingView {
  if (input.policy === "comped") return "comped";
  if (input.stripeSubscriptionStatus === "active" && input.cancelAtPeriodEnd) return "canceling";
  if (input.stripeSubscriptionStatus === "active") return "active";
  if (input.stripeSubscriptionStatus === "trialing") return "trialing";
  if (
    input.stripeSubscriptionStatus === "past_due" ||
    input.stripeSubscriptionStatus === "unpaid" ||
    input.stripeSubscriptionStatus === "paused"
  ) {
    return "payment_attention";
  }
  if (input.stripeSubscriptionStatus === "incomplete") return "checkout_incomplete";
  if (
    input.stripeSubscriptionStatus === "canceled" ||
    input.stripeSubscriptionStatus === "incomplete_expired"
  ) {
    return "canceled";
  }
  return "not_started";
}
