// The customer's five-phase journey, derived from facts that already exist.
// One function answers the only three questions a customer has: where am I,
// whose turn is it, and what (if anything) do I do next. Pure and tested.

export type JourneyPhaseState = "done" | "current" | "upcoming";
export type JourneyTurn = "you" | "relay" | "carrier" | "nobody";

export type JourneyPhase = {
  key: "kickoff" | "details" | "number" | "carrier" | "live";
  label: string;
  state: JourneyPhaseState;
  turn: JourneyTurn;
  detail: string;
};

export type OwnerJourneyInput = {
  setupFeeStatus: string | null | undefined;
  firstPaidAt?: string | null;
  profileComplete: boolean;
  twilioNumberAssigned: boolean;
  a2pStatus: string | null | undefined; // not_started | in_progress | approved | rejected | paused
  billingStatus: string | null | undefined;
  activatedAt?: string | null;
  callCaptureVerified: boolean;
};

export function computeOwnerJourney(input: OwnerJourneyInput): { phases: JourneyPhase[]; currentIndex: number } {
  const feeSettled =
    input.setupFeeStatus === "paid" || input.setupFeeStatus === "waived" || Boolean(input.firstPaidAt);
  const carrierApproved = input.a2pStatus === "approved";
  const isLive =
    Boolean(input.activatedAt) ||
    input.billingStatus === "active" ||
    input.billingStatus === "trialing" ||
    input.billingStatus === "comped";

  const done = [
    feeSettled,
    input.profileComplete,
    input.twilioNumberAssigned,
    carrierApproved,
    isLive && input.callCaptureVerified,
  ];
  let currentIndex = done.findIndex((value) => !value);
  if (currentIndex === -1) currentIndex = 4; // fully live: keep the last phase current/done

  const allDone = done.every(Boolean);

  function state(index: number): JourneyPhaseState {
    if (done[index]) return "done";
    return index === currentIndex ? "current" : "upcoming";
  }

  const carrierBlocked = input.a2pStatus === "rejected" || input.a2pStatus === "paused";

  const phases: JourneyPhase[] = [
    {
      key: "kickoff",
      label: "Kickoff",
      state: state(0),
      turn: done[0] ? "nobody" : "you",
      detail: done[0]
        ? input.setupFeeStatus === "waived"
          ? "Setup fee waived"
          : "Setup fee paid"
        : "Pay the one-time $150 setup fee to get started.",
    },
    {
      key: "details",
      label: "Your details",
      state: state(1),
      turn: done[1] ? "nobody" : "you",
      detail: done[1]
        ? "Business details are complete"
        : "A few business details — Relay can fill these in with you on your setup call.",
    },
    {
      key: "number",
      label: "Your number",
      state: state(2),
      turn: done[2] ? "nobody" : "relay",
      detail: done[2]
        ? "Relay number assigned"
        : "Relay is setting up your number — nothing needed from you.",
    },
    {
      key: "carrier",
      label: "Carrier approval",
      state: state(3),
      turn: done[3] ? "nobody" : carrierBlocked ? "relay" : "carrier",
      detail: done[3]
        ? "Carriers approved your business"
        : carrierBlocked
          ? "Relay is resolving a carrier issue — nothing needed from you."
          : "Phone carriers are reviewing your registration (typically 1–3 weeks) — nothing needed from you.",
    },
    {
      key: "live",
      label: "Go live",
      state: allDone ? "done" : state(4),
      turn: allDone ? "nobody" : done.slice(0, 4).every(Boolean) ? "you" : "nobody",
      detail: allDone
        ? "Relay is live and catching missed calls"
        : "One test call together, then Relay is on.",
    },
  ];

  return { phases, currentIndex: allDone ? 4 : currentIndex };
}
