export type OpsLifecycleStage = "kickoff" | "setting_up" | "carrier_review" | "ready_to_activate" | "active" | "canceled" | "paused";

export type OpsLifecycleInput = {
  onboardingStatus: string | null | undefined;
  billingStatus: string | null | undefined;
  setupFeeStatus?: string | null;
  activatedAt?: string | null;
  cancelAtPeriodEnd?: boolean;
  currentPeriodEnd?: string | null;
  onboardingStatusUpdatedAt?: string | null;
  updatedAt?: string | null;
};

export type OpsLifecycle = {
  stage: OpsLifecycleStage;
  label: string;
  daysInStage: number | null;
  blockedOn: string;
  primaryAction: string;
};

function daysSince(value: string | null | undefined) {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

function shortDate(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function getOpsLifecycle(input: OpsLifecycleInput): OpsLifecycle {
  let stage: OpsLifecycleStage;
  if (input.cancelAtPeriodEnd || input.billingStatus === "canceled") stage = "canceled";
  else if (input.billingStatus === "active" || input.billingStatus === "trialing" || input.billingStatus === "comped" || input.activatedAt || input.onboardingStatus === "activated") stage = "active";
  else if (input.onboardingStatus === "paused_incomplete" || input.onboardingStatus === "closed_incomplete") stage = "paused";
  else if (input.onboardingStatus === "carrier_review" || input.onboardingStatus === "carrier_attention") stage = "carrier_review";
  else if (input.onboardingStatus === "ready_to_activate") stage = "ready_to_activate";
  else if (input.onboardingStatus === "requirements_needed" || input.onboardingStatus === "waiting_on_customer") stage = "kickoff";
  else if (input.onboardingStatus === "ready_for_carrier") stage = "setting_up";
  else stage = "setting_up";

  const copy: Record<OpsLifecycleStage, Omit<OpsLifecycle, "stage" | "daysInStage">> = {
    kickoff: { label: "Kickoff", blockedOn: input.setupFeeStatus === "paid" || input.setupFeeStatus === "waived" ? "Kickoff is paid" : "Kickoff payment", primaryAction: "Send kickoff" },
    setting_up: { label: "Setting up", blockedOn: "Setup requirements", primaryAction: "Review setup" },
    carrier_review: { label: "Carrier review", blockedOn: "Carrier approval", primaryAction: "Monitor approval" },
    ready_to_activate: { label: "Ready", blockedOn: "Nothing — ready to activate", primaryAction: "Activate" },
    active: { label: "Active", blockedOn: "Nothing needed from you", primaryAction: "Open account" },
    canceled: input.cancelAtPeriodEnd
      ? {
          label: "Canceling",
          blockedOn: shortDate(input.currentPeriodEnd)
            ? `Subscription ends ${shortDate(input.currentPeriodEnd)}`
            : "Subscription will end after the current billing period",
          primaryAction: "Review cancellation",
        }
      : { label: "Canceled", blockedOn: "Subscription ended", primaryAction: "Review account" },
    paused: { label: "Paused", blockedOn: "Customer requirements", primaryAction: "Follow up" },
  };
  return { stage, daysInStage: daysSince(input.onboardingStatusUpdatedAt ?? input.updatedAt), ...copy[stage] };
}
