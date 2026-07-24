import type {
  A2pRegistrationStatus,
  BillingPolicy,
  OperationsBlocker,
  TechnicalSetupStatus,
} from "@/lib/customer-experience-contract";

export type OpsCallsState =
  | "setting_up"
  | "waiting_for_forwarding"
  | "ready"
  | "paused";

export type OpsTextingState =
  | "preparing"
  | "carrier_review"
  | "approved"
  | "issue";

export type OpsBillingState =
  | "setup_due"
  | "card_ready"
  | "trial"
  | "active"
  | "attention"
  | "canceled";

export type OpsQueueGroup =
  | "needs_attention"
  | "onboarding"
  | "running"
  | "paused";

export type OpsNextActionKey =
  | "resolve_relay_blocker"
  | "follow_up_customer"
  | "monitor_carrier_blocker"
  | "review_call_hold"
  | "resolve_billing"
  | "review_cancellation"
  | "resolve_texting_issue"
  | "finish_call_setup"
  | "help_with_forwarding"
  | "prepare_a2p"
  | "monitor_carrier_review"
  | "review_canceled_subscription"
  | "complete_setup_payment"
  | "collect_payment_method"
  | "enable_text_back"
  | "check_trial_activation"
  | "none";

export type OpsNextAction = {
  key: OpsNextActionKey;
  label: string;
  detail: string;
  owner: "relay" | "customer" | "carrier" | "stripe" | "none";
};

export type OpsStateInput = {
  technicalStatus: TechnicalSetupStatus | string | null | undefined;
  a2pStatus: A2pRegistrationStatus | string | null | undefined;
  smsEnabled: boolean;
  billingStatus: string | null | undefined;
  billingPolicy: BillingPolicy | string | null | undefined;
  stripeSubscriptionStatus: string | null | undefined;
  setupFeeStatus: string | null | undefined;
  stripeDefaultPaymentMethodId: string | null | undefined;
  cancelAtPeriodEnd?: boolean;
  blockedBy: OperationsBlocker | string | null | undefined;
  blockerNote?: string | null;
  blockedSince?: string | null;
  now?: Date;
};

export type OpsDerivedState = {
  calls: OpsCallsState;
  texting: OpsTextingState;
  billing: OpsBillingState;
  blockedBy: OperationsBlocker;
  blockerNote: string | null;
  blockedAgeDays: number | null;
  queueGroup: OpsQueueGroup;
  queueLabel: string;
  labels: {
    calls: string;
    texting: string;
    billing: string;
    blocker: string;
  };
  nextAction: OpsNextAction;
};

const QUEUE_LABELS: Record<OpsQueueGroup, string> = {
  needs_attention: "Needs attention",
  onboarding: "Onboarding",
  running: "Running",
  paused: "Paused or closed",
};

const CALLS_LABELS: Record<OpsCallsState, string> = {
  setting_up: "Setting up",
  waiting_for_forwarding: "Waiting for forwarding",
  ready: "Ready",
  paused: "Paused",
};

const TEXTING_LABELS: Record<OpsTextingState, string> = {
  preparing: "Preparing",
  carrier_review: "Carrier review",
  approved: "Approved",
  issue: "Issue",
};

const BILLING_LABELS: Record<OpsBillingState, string> = {
  setup_due: "Setup due",
  card_ready: "Card ready",
  trial: "Trial",
  active: "Active",
  attention: "Attention",
  canceled: "Canceled",
};

const BLOCKER_LABELS: Record<OperationsBlocker, string> = {
  none: "None",
  relay: "Relay",
  customer: "Customer",
  carrier: "Carrier",
};

export function normalizeOpsBlocker(
  value: string | null | undefined,
): OperationsBlocker {
  return value === "relay" || value === "customer" || value === "carrier"
    ? value
    : "none";
}

export function deriveOpsCallsState(
  value: string | null | undefined,
): OpsCallsState {
  if (value === "live" || value === "activated" || value === "ready_to_activate") {
    return "ready";
  }
  if (value === "waiting_for_forwarding" || value === "waiting_on_customer") {
    return "waiting_for_forwarding";
  }
  if (
    value === "paused" ||
    value === "closed" ||
    value === "paused_incomplete" ||
    value === "closed_incomplete"
  ) {
    return "paused";
  }
  return "setting_up";
}

export function deriveOpsTextingState(
  value: string | null | undefined,
): OpsTextingState {
  if (value === "approved") return "approved";
  if (value === "in_progress") return "carrier_review";
  if (
    value === "needs_attention" ||
    value === "rejected" ||
    value === "paused"
  ) {
    return "issue";
  }
  return "preparing";
}

function setupFeeSettled(input: OpsStateInput) {
  if (input.billingPolicy === "setup_fee_waived" || input.billingPolicy === "comped") {
    return true;
  }
  return (
    input.setupFeeStatus === "paid" ||
    input.setupFeeStatus === "waived" ||
    input.setupFeeStatus === "partially_refunded"
  );
}

// Stripe-synchronized fields are the only path to trial, active, attention,
// or canceled. Relay policy can make pre-subscription setup commercially ready,
// but it never manufactures a Stripe subscription state.
export function deriveOpsBillingState(input: OpsStateInput): OpsBillingState {
  const stripeStatus = input.stripeSubscriptionStatus;
  const billingStatus = input.billingStatus;

  if (
    stripeStatus === "canceled" ||
    stripeStatus === "incomplete_expired" ||
    billingStatus === "canceled"
  ) {
    return "canceled";
  }

  if (
    stripeStatus === "past_due" ||
    stripeStatus === "unpaid" ||
    stripeStatus === "incomplete" ||
    stripeStatus === "paused" ||
    billingStatus === "past_due" ||
    input.setupFeeStatus === "disputed" ||
    input.setupFeeStatus === "charged_back"
  ) {
    return "attention";
  }

  if (stripeStatus === "trialing" || billingStatus === "trialing") {
    return "trial";
  }

  if (stripeStatus === "active" || billingStatus === "active") {
    return "active";
  }

  if (
    !setupFeeSettled(input) ||
    (!input.stripeDefaultPaymentMethodId && input.billingPolicy !== "comped")
  ) {
    return "setup_due";
  }

  return "card_ready";
}

function daysSince(value: string | null | undefined, now: Date) {
  if (!value) return null;
  const startedAt = new Date(value).getTime();
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(0, Math.floor((now.getTime() - startedAt) / 86_400_000));
}

function action(
  key: OpsNextActionKey,
  label: string,
  detail: string,
  owner: OpsNextAction["owner"],
): OpsNextAction {
  return { key, label, detail, owner };
}

function deriveNextAction(input: {
  calls: OpsCallsState;
  texting: OpsTextingState;
  billing: OpsBillingState;
  billingPolicy: string | null | undefined;
  setupFeeSettled: boolean;
  smsEnabled: boolean;
  cancelAtPeriodEnd: boolean;
  blockedBy: OperationsBlocker;
  blockerNote: string | null;
}): OpsNextAction {
  if (input.blockedBy === "relay") {
    return action(
      "resolve_relay_blocker",
      "Resolve Relay blocker",
      input.blockerNote ?? "Finish the Relay-owned work holding this account.",
      "relay",
    );
  }
  if (input.blockedBy === "customer") {
    return action(
      "follow_up_customer",
      "Follow up with customer",
      input.blockerNote ?? "Request the specific item needed from the customer.",
      "customer",
    );
  }
  if (input.blockedBy === "carrier") {
    return action(
      "monitor_carrier_blocker",
      "Monitor carrier blocker",
      input.blockerNote ?? "Track the carrier-owned issue until it changes.",
      "carrier",
    );
  }
  if (input.calls === "paused") {
    return action(
      "review_call_hold",
      "Review call hold",
      "Calls are explicitly paused. Resume setup only when the hold is resolved.",
      "relay",
    );
  }
  if (input.billing === "attention") {
    return action(
      "resolve_billing",
      "Resolve billing in Stripe",
      "Review the Stripe issue and direct the customer to the secure billing path.",
      "stripe",
    );
  }
  if (input.cancelAtPeriodEnd) {
    return action(
      "review_cancellation",
      "Review scheduled cancellation",
      "Stripe will end the subscription at the current period boundary.",
      "stripe",
    );
  }
  if (input.billing === "canceled") {
    return action(
      "review_canceled_subscription",
      "Review canceled subscription",
      "Confirm the customer's intent before offering Stripe's authenticated restart path.",
      "stripe",
    );
  }
  if (input.texting === "issue") {
    return action(
      "resolve_texting_issue",
      "Resolve texting issue",
      "Review the Twilio or carrier response and record the responsible blocker.",
      "relay",
    );
  }
  if (input.billing === "setup_due") {
    if (!input.setupFeeSettled) {
      return action(
        "complete_setup_payment",
        "Complete setup payment",
        "Collect the standard setup fee or record an approved commercial exception.",
        "customer",
      );
    }
    return action(
      "collect_payment_method",
      "Collect payment method",
      "Use Stripe's secure no-charge card setup before activation.",
      "customer",
    );
  }
  if (input.calls === "setting_up") {
    return action(
      "finish_call_setup",
      "Finish call setup",
      "Assign and configure the Relay number. Readiness comes from a signed real missed call.",
      "relay",
    );
  }
  if (input.calls === "waiting_for_forwarding") {
    return action(
      "help_with_forwarding",
      "Help customer enable forwarding",
      "Complete forwarding with the customer, then let a signed real missed call prove readiness.",
      "customer",
    );
  }
  if (input.texting === "preparing") {
    return action(
      "prepare_a2p",
      "Prepare A2P registration",
      "Collect the minimum registration details and submit through Twilio.",
      "relay",
    );
  }
  if (input.texting === "carrier_review") {
    return action(
      "monitor_carrier_review",
      "Monitor carrier review",
      "Twilio or the carrier is reviewing the registration. Trial time remains untouched.",
      "carrier",
    );
  }
  if (!input.smsEnabled) {
    return action(
      "enable_text_back",
      "Enable automatic text-back",
      "A2P is approved. Turn on automatic text-back with the customer before starting trial time.",
      "customer",
    );
  }
  if (input.billingPolicy === "comped") {
    return action(
      "none",
      "No action needed",
      "Automatic text-back is running under an audited Relay comp.",
      "none",
    );
  }
  if (input.billing === "card_ready") {
    return action(
      "check_trial_activation",
      "Check trial activation",
      "All prerequisites are ready. The idempotent Stripe activation should start the delayed trial.",
      "relay",
    );
  }
  return action(
    "none",
    "No action needed",
    input.billing === "trial"
      ? "The Stripe trial is running."
      : "The account is running and Stripe billing is active.",
    "none",
  );
}

function deriveQueueGroup(input: {
  calls: OpsCallsState;
  texting: OpsTextingState;
  billing: OpsBillingState;
  billingPolicy: string | null | undefined;
  smsEnabled: boolean;
  cancelAtPeriodEnd: boolean;
  blockedBy: OperationsBlocker;
}): OpsQueueGroup {
  if (input.calls === "paused") return "paused";
  if (
    input.blockedBy !== "none" ||
    input.texting === "issue" ||
    input.billing === "attention" ||
    input.billing === "canceled"
  ) {
    return "needs_attention";
  }
  if (
    input.calls !== "ready" ||
    input.texting !== "approved" ||
    !input.smsEnabled ||
    input.billing === "setup_due" ||
    (input.billing === "card_ready" && input.billingPolicy !== "comped")
  ) {
    return "onboarding";
  }
  return "running";
}

export function deriveOpsState(input: OpsStateInput): OpsDerivedState {
  const calls = deriveOpsCallsState(input.technicalStatus);
  const texting = deriveOpsTextingState(input.a2pStatus);
  const billing = deriveOpsBillingState(input);
  const blockedBy = normalizeOpsBlocker(input.blockedBy);
  const blockerNote = blockedBy === "none"
    ? null
    : input.blockerNote?.trim() || null;
  const queueGroup = deriveQueueGroup({
    calls,
    texting,
    billing,
    billingPolicy: input.billingPolicy,
    smsEnabled: input.smsEnabled,
    cancelAtPeriodEnd: Boolean(input.cancelAtPeriodEnd),
    blockedBy,
  });

  return {
    calls,
    texting,
    billing,
    blockedBy,
    blockerNote,
    blockedAgeDays: blockedBy === "none"
      ? null
      : daysSince(input.blockedSince, input.now ?? new Date()),
    queueGroup,
    queueLabel: QUEUE_LABELS[queueGroup],
    labels: {
      calls: CALLS_LABELS[calls],
      texting: TEXTING_LABELS[texting],
      billing: BILLING_LABELS[billing],
      blocker: BLOCKER_LABELS[blockedBy],
    },
    nextAction: deriveNextAction({
      calls,
      texting,
      billing,
      billingPolicy: input.billingPolicy,
      setupFeeSettled: setupFeeSettled(input),
      smsEnabled: input.smsEnabled,
      cancelAtPeriodEnd: Boolean(input.cancelAtPeriodEnd),
      blockedBy,
      blockerNote,
    }),
  };
}
