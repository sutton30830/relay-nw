"use client";

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@/components/icon";
import { FORWARDING_HEALTH_CHECK_WINDOW_MS, type ForwardingHealthSummary } from "@/lib/forwarding-health";
import { fetchForwardingHealthStatus, startForwardingHealthCheck } from "../_api";

function formatDateTime(value: string | null) {
  if (!value) {
    return "No passed test yet";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusClass(status: ForwardingHealthSummary["displayStatus"]) {
  if (status === "passed") {
    return "forwarding-health__status--passed";
  }

  if (status === "pending") {
    return "forwarding-health__status--pending";
  }

  if (status === "failed") {
    return "forwarding-health__status--failed";
  }

  return "forwarding-health__status--unknown";
}

export function ForwardingHealthCard({ initialSummary }: { initialSummary: ForwardingHealthSummary }) {
  const [summary, setSummary] = useState(initialSummary);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const canRunAt = summary.canRunAt ? new Date(summary.canRunAt).getTime() : null;
  const isCoolingDown = canRunAt !== null && canRunAt > now;
  const pendingStartedAt = summary.latest?.status === "pending" ? new Date(summary.latest.started_at).getTime() : null;
  const isStalePending =
    pendingStartedAt !== null && pendingStartedAt + FORWARDING_HEALTH_CHECK_WINDOW_MS + 5000 <= now;
  const displayStatus = isStalePending ? "failed" : summary.displayStatus;
  const statusLabel = isStalePending ? "Failed" : summary.statusLabel;
  const failureText = isStalePending
    ? "Relay did not receive a forwarded call during the listening window. Call the owner number from your personal cell and let it go unanswered."
    : summary.failureText;
  const isPending = displayStatus === "pending";
  const isButtonDisabled = isStarting || isPending || isCoolingDown;
  const lastPassed = useMemo(() => formatDateTime(summary.lastPassedAt), [summary.lastPassedAt]);

  async function refreshStatus() {
    setSummary(await fetchForwardingHealthStatus());
    setError(null);
  }

  useEffect(() => {
    const currentTime = Date.now();

    if (!canRunAt || canRunAt <= currentTime) {
      return;
    }

    const timeoutId = window.setTimeout(() => setNow(Date.now()), Math.max(canRunAt - currentTime, 1000));

    return () => window.clearTimeout(timeoutId);
  }, [canRunAt, now]);

  useEffect(() => {
    if (!isPending) {
      return;
    }

    void refreshStatus().catch((pollError) => {
      const message = pollError instanceof Error ? pollError.message : "Unable to refresh forwarding health status.";
      setError(message);
    });

    const intervalId = window.setInterval(async () => {
      try {
        await refreshStatus();
      } catch (pollError) {
        const message = pollError instanceof Error ? pollError.message : "Unable to refresh forwarding health status.";
        setError(message);
      }
    }, 3000);

    const timeoutId = window.setTimeout(() => {
      setNow(Date.now());
      void refreshStatus().catch((pollError) => {
        const message = pollError instanceof Error ? pollError.message : "Unable to refresh forwarding health status.";
        setError(message);
      });
    }, FORWARDING_HEALTH_CHECK_WINDOW_MS + 5000);

    return () => {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    };
  }, [isPending]);

  async function handleStart() {
    setIsStarting(true);
    setError(null);

    try {
      setSummary(await startForwardingHealthCheck());
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : "Unable to start forwarding health check.";
      setError(message);
    } finally {
      setIsStarting(false);
    }
  }

  return (
    <section className="forwarding-health" aria-live="polite">
      <div className="forwarding-health__main">
        <div className="forwarding-health__icon">
          <Icon name="phoneMissed" size={18} />
        </div>
        <div>
          <p className="t-eyebrow">Forwarding status</p>
          <h3 className="forwarding-health__title">
            <span className={`forwarding-health__status ${statusClass(displayStatus)}`}>
              {statusLabel}
            </span>
            <span>{lastPassed}</span>
          </h3>
          <p className="forwarding-health__note">
            {error ?? failureText ?? "Click Start listening, then call the owner number from your personal cell and let it go unanswered."}
          </p>
        </div>
      </div>

      <button className="btn btn-secondary btn-sm" type="button" onClick={handleStart} disabled={isButtonDisabled}>
        <Icon name={isPending || isStarting ? "clock" : "phone"} size={14} />
        {isPending ? "Listening..." : isStarting ? "Starting..." : isCoolingDown ? "Cooling down" : "Start listening"}
      </button>
    </section>
  );
}
