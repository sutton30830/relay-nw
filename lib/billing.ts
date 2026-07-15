import type { SetupReadiness } from "@/lib/readiness";

export type AccountBillingStatus = "not_started" | "trialing" | "active" | "past_due" | "canceled" | "comped";

export type AccountBillingRecord = {
  billingStatus: AccountBillingStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  trialEndsAt: string | null;
  billingUpdatedAt: string | null;
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
  label: string;
  headline: string;
  summary: string;
  tone: "good" | "warn" | "neutral";
};

const DEFAULT_BILLING_RECORD: AccountBillingRecord = {
  billingStatus: "not_started",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  stripePriceId: null,
  trialEndsAt: null,
  billingUpdatedAt: null,
};

export function defaultBillingRecord(): AccountBillingRecord {
  return { ...DEFAULT_BILLING_RECORD };
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

export function isBillingActivationReady(readiness: Pick<SetupReadiness, "callCaptureReady" | "smsRegistrationReady">) {
  return readiness.callCaptureReady && readiness.smsRegistrationReady;
}

function trialSummary(trialEndsAt: string | null) {
  if (!trialEndsAt) {
    return "Billing is in trial mode. Relay should keep working while the subscription is checked.";
  }

  return `Trial is active until ${new Date(trialEndsAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}.`;
}

export function computeBillingReadiness(input: {
  billing: AccountBillingRecord | null | undefined;
  setupReadiness: Pick<SetupReadiness, "callCaptureReady" | "smsRegistrationReady">;
}): BillingReadiness {
  const billing = input.billing ?? defaultBillingRecord();
  const billingStatus = normalizeBillingStatus(billing.billingStatus);
  const activationReady = isBillingActivationReady(input.setupReadiness);

  if (billingStatus === "active") {
    return {
      state: "active",
      activationReady,
      billingStatus,
      label: "Billing active",
      headline: "Subscription is active.",
      summary: "This account has an active billing record.",
      tone: "good",
    };
  }

  if (billingStatus === "comped") {
    return {
      state: "comped",
      activationReady,
      billingStatus,
      label: "Comped",
      headline: "Billing is comped.",
      summary: "Relay is intentionally not charging this account.",
      tone: "neutral",
    };
  }

  if (billingStatus === "trialing") {
    return {
      state: "trialing",
      activationReady,
      billingStatus,
      label: "Trial",
      headline: "Trial is active.",
      summary: trialSummary(billing.trialEndsAt),
      tone: "good",
    };
  }

  if (billingStatus === "past_due" || billingStatus === "canceled") {
    return {
      state: "billing_attention",
      activationReady,
      billingStatus,
      label: billingStatus === "past_due" ? "Past due" : "Canceled",
      headline: billingStatus === "past_due" ? "Billing needs attention." : "Subscription is canceled.",
      summary: "Do not automatically disable missed-call capture in Phase 5A; resolve billing before scaling enforcement.",
      tone: "warn",
    };
  }

  if (activationReady) {
    return {
      state: "ready_to_start_billing",
      activationReady,
      billingStatus,
      label: "Ready to bill",
      headline: "Relay is ready for activation billing.",
      summary: "Call capture and carrier texting are ready. Start billing when the customer is handed off.",
      tone: "warn",
    };
  }

  return {
    state: "setup_not_billable",
    activationReady,
    billingStatus,
    label: "Setup first",
    headline: "Billing should wait.",
    summary: "Finish call capture and carrier texting approval before charging this account.",
    tone: "neutral",
  };
}
