// A single, decisive account readiness model for the Setup page. The important
// distinction: Relay can be fully configured while the owner intentionally
// pauses automatic texting. A paused SMS switch is an operating choice, not a
// failed setup.
//
// Pure and dependency-free so it can be unit-tested in isolation.

export type OperatingState = "setup_needed" | "calls_ready_sms_pending" | "live_sms_on" | "live_sms_paused";
export type ReadinessState = OperatingState;

export type ReadinessCheckStatus = "ok" | "pending" | "blocked";

export type ReadinessCheckKey = "profile" | "carrier" | "routing" | "texting";

export type ReadinessCheck = {
  key: ReadinessCheckKey;
  label: string;
  status: ReadinessCheckStatus;
  detail: string;
};

export type ReadinessAction = { label: string; href: string } | null;

// The only proof that Relay is working is a real recovered call.
export type ReadinessEvidence = { label: string; at: string } | null;

export type SetupReadiness = {
  state: ReadinessState;
  operatingState: OperatingState;
  callCaptureReady: boolean;
  smsRegistrationReady: boolean;
  smsEnabled: boolean;
  stateLabel: string;
  headline: string;
  summary: string;
  nextAction: ReadinessAction;
  checks: ReadinessCheck[];
  evidence: ReadinessEvidence;
};

export type A2pStatus = "not_started" | "in_progress" | "approved" | "needs_attention" | "rejected" | "paused" | "unknown";

export type ReadinessSignals = {
  role: "owner" | "admin" | "viewer";
  hasProfile: boolean;
  smsEnabled: boolean;
  a2pStatus: A2pStatus;
  // At least one real missed call has flowed all the way into the inbox — the
  // only proof that the pipeline works end-to-end.
  hasRecoveredCall: boolean;
  // Timestamp behind the proof, for showing how recently Relay was confirmed
  // working. Null when there's no such evidence yet.
  lastRecoveredCallAt: string | null;
};

function pickEvidence(signals: ReadinessSignals): ReadinessEvidence {
  return signals.lastRecoveredCallAt
    ? { label: "Caught a real missed call", at: signals.lastRecoveredCallAt }
    : null;
}

const STATE_LABELS: Record<OperatingState, string> = {
  setup_needed: "Setup needed",
  calls_ready_sms_pending: "Calls ready · Texting not ready",
  live_sms_on: "Live · Auto-text on",
  live_sms_paused: "Live · Auto-text paused",
};

function profileCheck(signals: ReadinessSignals): ReadinessCheck {
  return {
    key: "profile",
    label: "Business profile",
    status: signals.hasProfile ? "ok" : "blocked",
    detail: signals.hasProfile
      ? "Your business name, phone, and Relay number are set."
      : "Add your business name, phone, and Relay number.",
  };
}

function carrierCheck(signals: ReadinessSignals): ReadinessCheck {
  const status: ReadinessCheckStatus =
    signals.a2pStatus === "approved"
      ? "ok"
      : signals.a2pStatus === "rejected" || signals.a2pStatus === "paused"
        ? "blocked"
        : "pending";
  const detail =
    signals.a2pStatus === "approved"
      ? "Carrier registration approved — texting can run."
      : signals.a2pStatus === "rejected"
        ? "Carrier registration was rejected. Contact Relay to re-file."
        : signals.a2pStatus === "paused"
          ? "Carrier registration is paused."
          : signals.a2pStatus === "in_progress"
            ? "Carrier review is in progress — usually a few days."
            : "Carrier registration hasn't started yet.";
  return { key: "carrier", label: "Carrier registration", status, detail };
}

function routingCheck(signals: ReadinessSignals): ReadinessCheck {
  return {
    key: "routing",
    label: "Call routing",
    status: signals.hasRecoveredCall ? "ok" : "pending",
    detail: signals.hasRecoveredCall
      ? "A real missed call has reached your inbox."
      : "Relay will confirm this automatically after the first real missed call.",
  };
}

// Texting has two gates: carrier registration must be ready, then the owner
// chooses whether automatic replies are on. These are deliberately separate.
function textingCheck(signals: ReadinessSignals): ReadinessCheck {
  if (signals.a2pStatus === "rejected" || signals.a2pStatus === "paused") {
    return {
      key: "texting",
      label: "Automatic texting",
      status: "blocked",
      detail:
        signals.a2pStatus === "rejected"
          ? "Carrier registration was rejected, so automatic texting can't run. Contact Relay to re-file."
          : "Carrier registration is paused, so automatic texting is off.",
    };
  }
  if (signals.a2pStatus !== "approved") {
    return {
      key: "texting",
      label: "Automatic texting",
      status: "pending",
      detail: "Carrier registration is not approved yet. Missed calls can still reach your inbox.",
    };
  }
  if (!signals.smsEnabled) {
    return {
      key: "texting",
      label: "Automatic texting",
      status: "pending",
      detail: "Approved and paused by choice. Turn it on in Settings when you want callers texted automatically.",
    };
  }
  return {
    key: "texting",
    label: "Automatic texting",
    status: "ok",
    detail: "Relay auto-texts every missed caller.",
  };
}

// The single most useful thing to do next, highest priority first.
function pickNextAction(signals: ReadinessSignals, checks: Record<ReadinessCheckKey, ReadinessCheck>): ReadinessAction {
  const canEdit = signals.role !== "viewer";

  if (checks.profile.status === "blocked") {
    return canEdit
      ? { label: "Complete your business profile", href: "/settings" }
      : { label: "Ask an owner to finish the profile", href: "/settings" };
  }
  if (signals.a2pStatus === "rejected" || signals.a2pStatus === "paused") {
    return { label: "Resolve carrier registration", href: "/settings" };
  }
  return null;
}

function computeOperatingState({
  callCaptureReady,
  smsRegistrationReady,
  smsEnabled,
}: {
  callCaptureReady: boolean;
  smsRegistrationReady: boolean;
  smsEnabled: boolean;
}): OperatingState {
  if (!callCaptureReady) return "setup_needed";
  if (!smsRegistrationReady) return "calls_ready_sms_pending";
  return smsEnabled ? "live_sms_on" : "live_sms_paused";
}

function headlineFor(state: OperatingState): string {
  if (state === "live_sms_on") return "Relay is live and texting callers.";
  if (state === "live_sms_paused") return "Relay is live. Auto-texting is paused.";
  if (state === "calls_ready_sms_pending") return "Calls are ready. Texting needs attention.";
  return "Relay needs setup.";
}

function summaryFor(state: OperatingState, signals: ReadinessSignals, checks: Record<ReadinessCheckKey, ReadinessCheck>) {
  if (state === "live_sms_on") {
    return "Missed calls will appear in your inbox, and callers will receive an immediate reply.";
  }
  if (state === "live_sms_paused") {
    return "Automatic texts are paused. Missed calls will still appear in your inbox, but callers will not receive an immediate reply.";
  }
  if (state === "calls_ready_sms_pending") {
    if (signals.a2pStatus === "rejected") {
      return "Missed calls will appear in your inbox, but carrier registration was rejected. Contact Relay to re-file before texting callers.";
    }
    if (signals.a2pStatus === "paused") {
      return "Missed calls will appear in your inbox, but carrier registration is paused. Resolve registration before texting callers.";
    }
    return "Missed calls will appear in your inbox. Automatic texting is not ready until carrier registration is approved.";
  }
  if (!signals.hasProfile) {
    return "Add your business details so Relay can start catching missed calls.";
  }
  return checks.routing.detail;
}

export function computeSetupReadiness(signals: ReadinessSignals): SetupReadiness {
  const checks: ReadinessCheck[] = [
    profileCheck(signals),
    carrierCheck(signals),
    routingCheck(signals),
    textingCheck(signals),
  ];
  const byKey = Object.fromEntries(checks.map((check) => [check.key, check])) as Record<ReadinessCheckKey, ReadinessCheck>;

  const callCaptureReady = signals.hasProfile && byKey.routing.status === "ok";
  const smsRegistrationReady = signals.a2pStatus === "approved";
  const operatingState = computeOperatingState({
    callCaptureReady,
    smsRegistrationReady,
    smsEnabled: signals.smsEnabled,
  });

  const nextAction = pickNextAction(signals, byKey);

  return {
    state: operatingState,
    operatingState,
    callCaptureReady,
    smsRegistrationReady,
    smsEnabled: signals.smsEnabled,
    stateLabel: STATE_LABELS[operatingState],
    headline: headlineFor(operatingState),
    summary: summaryFor(operatingState, signals, byKey),
    nextAction,
    checks,
    evidence: pickEvidence(signals),
  };
}
