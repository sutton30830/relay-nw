// A single, decisive account readiness state for the Setup page. The signals
// (profile, carrier registration, call routing, texting) already existed but
// were flattened into a vague "3/4 complete" that never answered the only
// question an owner has: "Is Relay actually live?" This turns them into one of
// four states with exactly one next action, so Setup can lead instead of list.
//
// Pure and dependency-free so it can be unit-tested in isolation.

export type ReadinessState = "not_ready" | "attention" | "testing" | "live";

export type ReadinessCheckStatus = "ok" | "pending" | "blocked";

export type ReadinessCheckKey = "profile" | "carrier" | "routing" | "texting";

export type ReadinessCheck = {
  key: ReadinessCheckKey;
  label: string;
  status: ReadinessCheckStatus;
  detail: string;
};

export type ReadinessAction = { label: string; href: string } | null;

export type SetupReadiness = {
  state: ReadinessState;
  stateLabel: string;
  headline: string;
  summary: string;
  nextAction: ReadinessAction;
  checks: ReadinessCheck[];
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
};

const STATE_LABELS: Record<ReadinessState, string> = {
  not_ready: "Not ready",
  attention: "Needs attention",
  testing: "Testing",
  live: "Live",
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

// Texting is an optional enhancement, not part of the core missed-call pipeline.
// It can be waiting on carrier (A2P) approval, or deliberately left off — neither
// blocks "Live". Only a rejected/paused registration is a real problem, and even
// then calls are still being caught.
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
      detail: "Optional. Turns on automatically once carrier registration is approved — no action needed.",
    };
  }
  if (!signals.smsEnabled) {
    return {
      key: "texting",
      label: "Automatic texting",
      status: "pending",
      detail: "Optional and approved — turn it on in Settings whenever you want it.",
    };
  }
  return {
    key: "texting",
    label: "Automatic texting",
    status: "ok",
    detail: "Relay auto-texts every missed caller.",
  };
}

// The single most useful thing to do next, highest priority first. Core-pipeline
// steps come before texting, and once the core is verified we only surface a
// texting action when it's genuinely broken (rejected/paused) — a deliberately
// off or A2P-pending switch is a wait/choice, not a to-do.
function pickNextAction(signals: ReadinessSignals, checks: Record<ReadinessCheckKey, ReadinessCheck>): ReadinessAction {
  const canEdit = signals.role !== "viewer";

  if (checks.profile.status === "blocked") {
    return canEdit
      ? { label: "Complete your business profile", href: "/settings" }
      : { label: "Ask an owner to finish the profile", href: "/settings" };
  }
  if (signals.callMode === "forwarding" && signals.forwardingStatus === "failed") {
    return { label: "Re-run the forwarding test", href: "/setup" };
  }
  if (signals.callMode === "forwarding" && checks.routing.status !== "ok") {
    return { label: "Run a forwarding test", href: "/setup" };
  }
  if (signals.callMode === "direct" && !signals.hasRecoveredCall) {
    return { label: "Make a test missed call", href: "/setup" };
  }
  // Core pipeline is live below. Texting only becomes a to-do if it's broken.
  if (signals.a2pStatus === "rejected" || signals.a2pStatus === "paused") {
    return { label: "Resolve carrier registration", href: "/setup" };
  }
  return null;
}

// When the core pipeline is live, describe what texting is doing (or waiting on)
// without ever demoting the account from Live.
function liveSummary(signals: ReadinessSignals): string {
  if (signals.a2pStatus === "approved" && signals.smsEnabled) {
    return "Missed calls are being caught and your callers get an instant text back.";
  }
  if (signals.a2pStatus === "approved" && !signals.smsEnabled) {
    return "Missed calls are being caught. Turn on automatic texting in Settings whenever you want it.";
  }
  if (signals.a2pStatus === "rejected" || signals.a2pStatus === "paused") {
    return "Missed calls are being caught. Automatic texting is unavailable until carrier registration is resolved.";
  }
  return "Missed calls are being caught. Automatic texting will switch on once carrier registration is approved.";
}

export function computeSetupReadiness(signals: ReadinessSignals): SetupReadiness {
  const checks: ReadinessCheck[] = [
    profileCheck(signals),
    carrierCheck(signals),
    routingCheck(signals),
    textingCheck(signals),
  ];
  const byKey = Object.fromEntries(checks.map((check) => [check.key, check])) as Record<ReadinessCheckKey, ReadinessCheck>;

  // The top-level state reflects only the core missed-call pipeline: is the
  // account configured (profile) and are missed calls actually reaching the
  // inbox (routing verified)? Texting is optional and never blocks Live.
  let state: ReadinessState;
  if (!signals.hasProfile) {
    state = "not_ready";
  } else if (byKey.routing.status === "blocked") {
    state = "attention";
  } else if (byKey.routing.status === "ok") {
    state = "live";
  } else {
    state = "testing";
  }

  const nextAction = pickNextAction(signals, byKey);

  const headline =
    state === "live"
      ? "Relay is live."
      : state === "attention"
        ? "Relay needs your attention."
        : state === "testing"
          ? "Almost there — let's test Relay."
          : "Relay isn't set up yet.";

  const summary =
    state === "live"
      ? liveSummary(signals)
      : state === "attention"
        ? byKey.routing.detail
        : state === "testing"
          ? "Run a quick test so you know missed calls are reaching your inbox."
          : "Add your business details so Relay can start catching missed calls.";

  return {
    state,
    stateLabel: STATE_LABELS[state],
    headline,
    summary,
    nextAction,
    checks,
  };
}
