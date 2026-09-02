export const PROVIDER_ACTION_STATUSES = [
  "pending",
  "processing",
  "accepted",
  "succeeded",
  "failed",
  "suppressed",
  "reconciled",
] as const;

export type ProviderActionStatus = typeof PROVIDER_ACTION_STATUSES[number];
export type RetryEligibility = "automatic" | "manual" | "never";
export type ProviderName = "twilio" | "dial" | "openai" | "resend" | "stripe" | "supabase" | "relay";

export type FailurePresentation = {
  customerExplanation: string;
  retryEligibility: RetryEligibility;
  recommendedNextAction: string;
  suppressed: boolean;
};

const LANDLINE_CODES = new Set(["30006", "21614"]);
const PERMANENT_SMS_CODES = new Set(["21211", "21408", "21610", "30003", "30004", "30005", "30006", "30007", "30008"]);
const TRANSIENT_CODES = new Set(["20429", "429", "500", "502", "503", "504", "ETIMEDOUT", "ECONNRESET"]);

export function providerFailureCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.match(/\b(?:20|21|30)\d{3}\b/)?.[0]
    ?? message.match(/\b(?:429|5\d\d)\b/)?.[0]
    ?? (/timed?\s*out/i.test(message) ? "ETIMEDOUT" : null);
}

export function sanitizeProviderDiagnostic(value: unknown) {
  let source: string;
  if (value instanceof Error) {
    source = value.message;
  } else if (typeof value === "string") {
    source = value;
  } else {
    try {
      source = JSON.stringify(value ?? "");
    } catch {
      source = String(value ?? "");
    }
  }
  return source
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\bBasic\s+[^\s,;]+/gi, "Basic [redacted]")
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/\bSG\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/([?&](?:token|key|secret|signature|password)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 1000);
}

export function isExpectedQualitySuppression(message: string | null | undefined) {
  return Boolean(message && (
    /No usable voicemail was recorded/i.test(message)
    || /No clear spoken message was detected/i.test(message)
    || /could not confidently transcribe/i.test(message)
    || /marked this transcript as wrong/i.test(message)
    || /recording_too_short/i.test(message)
    || /known_hallucination_pattern/i.test(message)
    || /transcription_models_disagree/i.test(message)
  ));
}

export function failurePresentation(input: {
  provider: ProviderName;
  action: string;
  providerStatus?: string | null;
  failureCode?: string | null;
  expectedSuppression?: boolean;
}): FailurePresentation {
  const code = input.failureCode?.trim() || null;
  const status = input.providerStatus?.toLowerCase() ?? "";

  if (input.expectedSuppression) {
    return {
      customerExplanation: "Relay did not publish an unreliable result. The original recording remains available.",
      retryEligibility: "never",
      recommendedNextAction: "Listen to the recording and contact the caller directly if needed.",
      suppressed: true,
    };
  }

  if (code && LANDLINE_CODES.has(code)) {
    return {
      customerExplanation: "This number cannot receive text messages.",
      retryEligibility: "never",
      recommendedNextAction: "Call the customer instead.",
      suppressed: false,
    };
  }

  if (input.provider === "twilio" && input.action.includes("sms") && code && PERMANENT_SMS_CODES.has(code)) {
    return {
      customerExplanation: "The carrier could not deliver this text message.",
      retryEligibility: "manual",
      recommendedNextAction: "Check the phone number and carrier status before sending a new message.",
      suppressed: false,
    };
  }

  const transient = Boolean(
    (code && TRANSIENT_CODES.has(code))
    || /timeout|temporar|unavailable|rate.?limit|connection reset/i.test(status),
  );

  if (transient) {
    return {
      customerExplanation: "The provider was temporarily unavailable. Relay kept the action for a safe retry.",
      retryEligibility: input.action.includes("automatic_missed_call_sms") ? "manual" : "automatic",
      recommendedNextAction: input.action.includes("automatic_missed_call_sms")
        ? "Confirm the original message was not accepted before retrying or call the customer."
        : "Wait for Relay's idempotent retry or retry once from Operations.",
      suppressed: false,
    };
  }

  if (input.provider === "stripe") {
    return {
      customerExplanation: "Relay could not confirm the latest billing update yet.",
      retryEligibility: "automatic",
      recommendedNextAction: "Run billing reconciliation; do not create a second charge or subscription.",
      suppressed: false,
    };
  }

  return {
    customerExplanation: "Relay could not complete this action. No duplicate action will be attempted automatically.",
    retryEligibility: "manual",
    recommendedNextAction: "Review the provider status in Operations before retrying.",
    suppressed: false,
  };
}

export function automaticRetryIsSafe(input: {
  action: string;
  status: ProviderActionStatus;
  retryEligibility: RetryEligibility;
  providerIdentifier?: string | null;
}) {
  if (input.retryEligibility !== "automatic" || input.status !== "failed") return false;
  // A provider identifier means an outbound request may already have been accepted.
  // Automatic SMS retries are therefore never safe; delivery callbacks reconcile them.
  if (input.action.includes("sms") || input.providerIdentifier) return false;
  return true;
}
