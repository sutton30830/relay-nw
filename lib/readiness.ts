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

// The freshest proof the pipeline actually works: a real recovered call beats a
// forwarding test (it exercises the whole path), and both carry a timestamp so
// the UI can show how recently Relay was confirmed working.
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

export type A2pStatus = "not_started" | "in_progress" | "approved" | "rejected" | "paused" | "unknown";
export type ForwardingStatus = "passed" | "failed" | "pending" | "unknown";

export type ReadinessSignals = {
  role: "owner" | "admin" | "viewer";
  hasProfile: boolean;
  callMode: "direct" | "forwarding";
  smsEnabled: boolean;
  a2pStatus: A2pStatus;
  forwardingStatus: ForwardingStatus;
  // At least one real missed call has flowed all the way into the inbox — the
  // only proof that the pipeline works end-to-end.
  hasRecoveredCall: boolean;
  // Timestamps behind the proof, for showing how recently Relay was confirmed
  // working. Null when there's no such evidence yet.
  lastRecoveredCallAt: string | null;
  forwardingLastPassedAt: string | null;
};

// The freshest evidence wins; a real recovered call outranks a forwarding test
// at the same time because it exercises the entire pipeline.
function pickEvidence(signals: ReadinessSignals): ReadinessEvidence {
  const candidates: Array<{ label: string; at: string; rank: number }> = [];
  if (signals.lastRecoveredCallAt) {
    candidates.push({ label: "Caught a real missed call", at: signals.lastRecoveredCallAt, rank: 1 });
  }
  if (signals.forwardingLastPassedAt) {
    candidates.push({ label: "Forwarding test passed", at: signals.forwardingLastPassedAt, rank: 0 });
  }
  candidates.sort((a, b) => {
    const timeDiff = new Date(b.at).getTime() - new Date(a.at).getTime();
    return timeDiff !== 0 ? timeDiff : b.rank - a.rank;
  });
  const best = candidates[0];
  return best ? { label: best.label, at: best.at } : null;
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
  if (signals.callMode === "direct") {
    return {
      key: "routing",
      label: "Call routing",
      status: signals.hasRecoveredCall ? "ok" : "pending",
      detail: signals.hasRecoveredCall
        ? "A real missed call has reached your inbox."
        : "Make a test missed call to your Relay number to confirm routing.",
    };
  }

  const status: ReadinessCheckStatus =
    signals.forwardingStatus === "passed"
      ? "ok"
      : signals.forwardingStatus === "failed"
        ? "blocked"
        : "pending";
  const detail =
    signals.forwardingStatus === "passed"
      ? "Forwarding test passed — missed calls reach Relay."
      : signals.forwardingStatus === "failed"
        ? "The last forwarding test failed. Re-check your carrier codes and run it again."
        : "Run a forwarding test: start listening, then call your business number and let it ring out.";
  return { key: "routing", label: "Call forwarding", status, detail };
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
  // The test actions scroll to the live-tests tool at the bottom of Setup, where
  // the actual "Start listening" control lives — a plain /setup link would just
  // reload the page the owner is already on.
  if (signals.callMode === "forwarding" && signals.forwardingStatus === "failed") {
    return { label: "Re-run the forwarding test", href: "/setup#live-tests" };
  }
  if (signals.callMode === "forwarding" && checks.routing.status !== "ok") {
    return { label: "Run a forwarding test", href: "/setup#live-tests" };
  }
  if (signals.callMode === "direct" && !signals.hasRecoveredCall) {
    return { label: "Make a test missed call", href: "/setup#live-tests" };
  }
  if (signals.a2pStatus === "rejected" || signals.a2pStatus === "paused") {
    return { label: "Resolve carrier registration", href: "/setup#live-tests" };
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
