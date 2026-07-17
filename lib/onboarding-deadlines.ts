import type { AccountOnboardingStatus } from "@/lib/billing";

const DAY_MS = 24 * 60 * 60 * 1000;

export type OnboardingDeadlineAction =
  | "none"
  | "remind_day_3"
  | "remind_day_7"
  | "pause_incomplete"
  | "close_incomplete";

export const ONBOARDING_DEADLINE_ACTIONS: Record<Exclude<OnboardingDeadlineAction, "none">, string> = {
  remind_day_3: "onboarding.reminder_day_3",
  remind_day_7: "onboarding.reminder_day_7",
  pause_incomplete: "onboarding.paused_incomplete",
  close_incomplete: "onboarding.closed_incomplete",
};

export function defaultRequirementsDueAt(now = new Date()) {
  return new Date(now.getTime() + 14 * DAY_MS).toISOString();
}

export function daysUntil(value: string, now = new Date()) {
  return Math.ceil((Date.parse(value) - now.getTime()) / DAY_MS);
}

export function ownerOnboardingDelayMessage(input: {
  onboardingStatus: AccountOnboardingStatus;
  requirementsDueAt: string | null;
  now?: Date;
}) {
  if (input.onboardingStatus !== "waiting_on_customer" || !input.requirementsDueAt) {
    return null;
  }

  const dueDate = new Date(input.requirementsDueAt).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

  return `We’re waiting for your business information. Complete it by ${dueDate} to keep setup moving.`;
}

export function chooseOnboardingDeadlineAction(input: {
  onboardingStatus: AccountOnboardingStatus;
  requirementsDueAt: string | null;
  completedActions?: Set<string>;
  now?: Date;
}): OnboardingDeadlineAction {
  if (!input.requirementsDueAt) {
    return "none";
  }

  const completedActions = input.completedActions ?? new Set<string>();
  const now = input.now ?? new Date();
  const dueAt = Date.parse(input.requirementsDueAt);

  if (!Number.isFinite(dueAt)) {
    return "none";
  }

  if (input.onboardingStatus === "paused_incomplete") {
    return now.getTime() >= dueAt + 16 * DAY_MS &&
      !completedActions.has(ONBOARDING_DEADLINE_ACTIONS.close_incomplete)
      ? "close_incomplete"
      : "none";
  }

  if (input.onboardingStatus !== "waiting_on_customer") {
    return "none";
  }

  if (now.getTime() >= dueAt) {
    return completedActions.has(ONBOARDING_DEADLINE_ACTIONS.pause_incomplete) ? "none" : "pause_incomplete";
  }

  if (now.getTime() >= dueAt - 7 * DAY_MS) {
    return completedActions.has(ONBOARDING_DEADLINE_ACTIONS.remind_day_7) ? "none" : "remind_day_7";
  }

  if (now.getTime() >= dueAt - 11 * DAY_MS) {
    return completedActions.has(ONBOARDING_DEADLINE_ACTIONS.remind_day_3) ? "none" : "remind_day_3";
  }

  return "none";
}
