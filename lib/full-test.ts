// Combines the individual setup checks (call forwarding, texting) into one
// verdict for the guided "Full test" panel, so an owner gets a single
// pass/fail instead of reading two cards. Pure and dependency-free.

export type LegStatus = "idle" | "pending" | "passed" | "failed";
export type FullTestState = "idle" | "running" | "verified" | "attention";

export type FullTestLeg = { key: string; label: string; status: LegStatus };

export type FullTestSummary = {
  state: FullTestState;
  headline: string;
  detail: string;
  passedCount: number;
  total: number;
};

export function combineFullTest(legs: FullTestLeg[]): FullTestSummary {
  const total = legs.length;
  const passedCount = legs.filter((leg) => leg.status === "passed").length;
  const failed = legs.filter((leg) => leg.status === "failed");
  const anyPending = legs.some((leg) => leg.status === "pending");
  const allPassed = total > 0 && legs.every((leg) => leg.status === "passed");

  let state: FullTestState;
  if (allPassed) {
    state = "verified";
  } else if (failed.length > 0) {
    state = "attention";
  } else if (anyPending) {
    state = "running";
  } else {
    state = "idle";
  }

  const headline =
    state === "verified"
      ? "Relay is fully verified."
      : state === "attention"
        ? "A check needs attention."
        : state === "running"
          ? "Testing Relay…"
          : "Confirm Relay works end to end.";

  const detail =
    state === "verified"
      ? `${legs.map((leg) => leg.label.toLowerCase()).join(" and ")} confirmed.`
      : state === "attention"
        ? `${failed.map((leg) => leg.label.toLowerCase()).join(" and ")} failed — see below.`
        : state === "running"
          ? "Waiting for the test to finish…"
          : total === 1
            ? "Run the check below."
            : `Run the ${total} checks below.`;

  return { state, headline, detail, passedCount, total };
}
