// Phase 0 contract for the simplified customer experience.
//
// This module is intentionally pure and is not wired into the current UI or
// database yet. It gives the implementation phases one shared vocabulary and
// makes the independence rules executable before migrations begin.

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

// Monthly billing may begin once call capture is live. Setup-fee and A2P
// states are intentionally not inputs and therefore cannot become hidden gates.
export function canStartMonthlyBilling(technicalStatus: TechnicalSetupStatus) {
  return technicalStatus === "live";
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
