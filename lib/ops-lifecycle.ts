export type OpsLifecycleStage = "setting_up" | "live" | "active" | "paused" | "closed" | "canceled";

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
  else if (input.onboardingStatus === "closed" || input.onboardingStatus === "closed_incomplete") stage = "closed";
  else if (input.onboardingStatus === "paused" || input.onboardingStatus === "paused_incomplete") stage = "paused";
  else if (input.billingStatus === "active" || input.billingStatus === "trialing" || input.billingStatus === "comped" || input.activatedAt || input.onboardingStatus === "activated") stage = "active";
  else if (input.onboardingStatus === "live") stage = "live";
  else stage = "setting_up";

  const copy: Record<OpsLifecycleStage, Omit<OpsLifecycle, "stage" | "daysInStage">> = {
    setting_up: { label: "Setting up", blockedOn: "Relay setup work", primaryAction: "Review setup" },
    live: { label: "Live", blockedOn: "Call capture is working", primaryAction: "Review account" },
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
    paused: { label: "Paused", blockedOn: "Operator follow-up", primaryAction: "Review account" },
    closed: { label: "Closed", blockedOn: "Account is closed", primaryAction: "Review account" },
  };
  return { stage, daysInStage: daysSince(input.onboardingStatusUpdatedAt ?? input.updatedAt), ...copy[stage] };
}
