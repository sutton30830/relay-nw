"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icon";
import { fetchSmsTestStatus, startSmsTest, type SmsTestResponse } from "../_api";

const FINAL_SMS_STATUSES = new Set(["sent", "delivered", "failed", "undelivered"]);

function smsStatusLabel(status: SmsTestResponse["status"]) {
  if (status === "delivered") return "Delivered";
  if (status === "failed") return "Failed";
  if (status === "undelivered") return "Undelivered";
  if (status === "sent") return "Sent";
  if (status === "sending") return "Sending";
  if (status === "queued" || status === "accepted") return "Queued";
  return "Not tested";
}

function smsStatusClass(status: SmsTestResponse["status"]) {
  if (status === "delivered" || status === "sent") return "sms-health__status--good";
  if (status === "failed" || status === "undelivered") return "sms-health__status--bad";
  if (status === "queued" || status === "sending" || status === "accepted") return "sms-health__status--pending";
  return "sms-health__status--unknown";
}

export function SmsHealthCard({
  onStatusChange,
}: {
  onStatusChange?: (status: "idle" | "pending" | "passed" | "failed") => void;
} = {}) {
  const [result, setResult] = useState<SmsTestResponse | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = result?.status;
  const messageSid = result?.messageSid;
  const isPolling = Boolean(messageSid && status && !FINAL_SMS_STATUSES.has(status));

  // Normalize Twilio's message status into the combined Full-test verdict.
  useEffect(() => {
    const normalized: "idle" | "pending" | "passed" | "failed" =
      status === "delivered" || status === "sent"
        ? "passed"
        : status === "failed" || status === "undelivered"
          ? "failed"
          : status === "queued" || status === "sending" || status === "accepted"
            ? "pending"
            : "idle";
    onStatusChange?.(normalized);
  }, [status, onStatusChange]);

  useEffect(() => {
    if (!messageSid || !isPolling) {
      return;
    }

    const intervalId = window.setInterval(async () => {
      try {
        setResult(await fetchSmsTestStatus(messageSid));
        setError(null);
      } catch (pollError) {
        const message = pollError instanceof Error ? pollError.message : "Unable to refresh SMS status.";
        setError(message);
      }
    }, 3000);

    return () => window.clearInterval(intervalId);
  }, [isPolling, messageSid]);

  async function handleStart() {
    setIsSending(true);
    setError(null);

    try {
      setResult(await startSmsTest());
    } catch (startError) {
      const message = startError instanceof Error ? startError.message : "Unable to send SMS test.";
      setError(message);
    } finally {
      setIsSending(false);
    }
  }

  const failureDetail = result?.errorMessage || result?.detail || null;
  const note = error
    ?? failureDetail
    ?? (result?.messageSid
      ? "Owner phone test completed."
      : "Sends one owner-only text to confirm Twilio outbound SMS is working.");

  return (
    <section className="sms-health" aria-live="polite">
      <div className="sms-health__main">
        <div className="sms-health__icon">
          <Icon name="send" size={18} />
        </div>
        <div>
          <p className="t-eyebrow">SMS status</p>
          <h3 className="sms-health__title">
            <span className={`sms-health__status ${smsStatusClass(status)}`}>
              {smsStatusLabel(status)}
            </span>
            <span>Owner phone</span>
          </h3>
          <p className="sms-health__note">{note}</p>
        </div>
      </div>

      <button className="btn btn-secondary btn-sm health-action-btn" type="button" onClick={handleStart} disabled={isSending || isPolling}>
        <Icon name={isSending || isPolling ? "clock" : "send"} size={14} />
        {isSending ? "Sending..." : isPolling ? "Checking..." : "Send test SMS"}
      </button>
    </section>
  );
}
