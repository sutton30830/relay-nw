import type { ForwardingHealthCheck, ForwardingHealthCheckFailureReason } from "@/lib/supabase";

export const FORWARDING_HEALTH_CHECK_WINDOW_MS = 90_000;
export const FORWARDING_HEALTH_CHECK_COOLDOWN_MS = 60_000;

export type ForwardingHealthSummary = {
  latest: ForwardingHealthCheck | null;
  lastPassedAt: string | null;
  displayStatus: "passed" | "failed" | "pending" | "unknown";
  statusLabel: string;
  failureText: string | null;
  canRunAt: string | null;
};

export function forwardingHealthFailureText(reason: ForwardingHealthCheckFailureReason) {
  if (reason === "no_forwarded_call_received") {
    return "Relay did not receive the forwarded call. Call forwarding may be off or voicemail may have intercepted it.";
  }

  if (reason === "twilio_outbound_failed") {
    return "Twilio could not place the test call.";
  }

  if (reason === "webhook_error") {
    return "Relay received the call but could not process the health check.";
  }

  if (reason === "rate_limited") {
    return "A health check was requested too soon after the previous one.";
  }

  if (reason === "unknown_error") {
    return "Relay could not complete the health check.";
  }

  return null;
}

export function forwardingHealthStatusLabel(check: ForwardingHealthCheck | null) {
  if (!check) {
    return "Unknown";
  }

  if (check.status === "passed") {
    return "Passed";
  }

  if (check.status === "pending") {
    return "Pending";
  }

  if (check.status === "timeout") {
    return "Failed";
  }

  return check.status === "error" ? "Error" : "Failed";
}

export function forwardingHealthDisplayStatus(check: ForwardingHealthCheck | null): ForwardingHealthSummary["displayStatus"] {
  if (!check) {
    return "unknown";
  }

  if (check.status === "passed") {
    return "passed";
  }

  if (check.status === "pending") {
    return "pending";
  }

  return "failed";
}

export function forwardingHealthRetryAt(check: ForwardingHealthCheck | null, now = Date.now()) {
  if (!check) {
    return null;
  }

  const retryAt = new Date(new Date(check.created_at).getTime() + FORWARDING_HEALTH_CHECK_COOLDOWN_MS);

  return retryAt.getTime() > now ? retryAt.toISOString() : null;
}
