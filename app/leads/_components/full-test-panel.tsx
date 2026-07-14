"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import type { ForwardingHealthSummary } from "@/lib/forwarding-health";
import { combineFullTest, type FullTestLeg, type LegStatus } from "@/lib/full-test";
import { ForwardingHealthCard } from "./forwarding-health-card";
import { SmsHealthCard } from "./sms-health-card";

// Guided end-to-end check: wraps the existing forwarding + SMS tests and rolls
// their live statuses into one verdict, so an owner runs the checks and gets a
// single "Relay is fully verified" instead of reading two cards. Reuses the
// proven per-leg mechanisms — no change to the call pipeline.
export function FullTestPanel({
  initialForwardingSummary,
  showForwarding,
}: {
  initialForwardingSummary: ForwardingHealthSummary;
  showForwarding: boolean;
}) {
  const router = useRouter();
  const [forwardingStatus, setForwardingStatus] = useState<LegStatus>("idle");
  const [smsStatus, setSmsStatus] = useState<LegStatus>("idle");

  // The readiness banner (and checklist) above are server-rendered from the
  // latest forwarding check. When a test finishes, refresh so they re-compute
  // from fresh data instead of contradicting the live verdict here.
  const lastForwarding = useRef<LegStatus>("idle");
  useEffect(() => {
    // Only when a running (pending) test settles — not on initial mount where an
    // already-passed check would otherwise trigger a spurious refresh.
    const testJustFinished =
      lastForwarding.current === "pending" && (forwardingStatus === "passed" || forwardingStatus === "failed");
    if (testJustFinished) {
      router.refresh();
    }
    lastForwarding.current = forwardingStatus;
  }, [forwardingStatus, router]);

  const legs: FullTestLeg[] = [
    ...(showForwarding ? [{ key: "forwarding", label: "Call forwarding", status: forwardingStatus }] : []),
    { key: "sms", label: "Texting", status: smsStatus },
  ];
  const summary = combineFullTest(legs);

  return (
    <div className="full-test">
      <div className={`full-test__verdict full-test__verdict--${summary.state}`}>
        <span className="full-test__count" aria-hidden="true">
          {summary.state === "verified" ? <Icon name="check" size={16} /> : `${summary.passedCount}/${summary.total}`}
        </span>
        <div>
          <p className="full-test__headline">{summary.headline}</p>
          <p className="full-test__detail">{summary.detail}</p>
        </div>
      </div>

      {showForwarding ? (
        <ForwardingHealthCard initialSummary={initialForwardingSummary} onStatusChange={setForwardingStatus} />
      ) : null}
      <SmsHealthCard onStatusChange={setSmsStatus} />
    </div>
  );
}
