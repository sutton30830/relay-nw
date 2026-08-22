import { isPlaceholderSupabaseConfig, supabaseAdmin } from "./client";
import { assertAccountId } from "./tenant";
import type { WebhookEvent, WebhookEventSource } from "./types";
import { recordProviderAction } from "./provider-actions";

function lastFour(value: string | undefined) {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) {
    return null;
  }

  return digits.slice(-4);
}

function stringValue(payload: Record<string, string>, key: string) {
  return payload[key]?.trim() || null;
}

function sanitizedWebhookPayload(payload: Record<string, string>) {
  const body = stringValue(payload, "Body");

  return {
    callSid: stringValue(payload, "CallSid"),
    parentCallSid: stringValue(payload, "ParentCallSid"),
    dialCallSid: stringValue(payload, "DialCallSid"),
    messageSid: stringValue(payload, "MessageSid") ?? stringValue(payload, "SmsSid"),
    recordingSid: stringValue(payload, "RecordingSid"),
    fromLast4: lastFour(payload.From),
    toLast4: lastFour(payload.To),
    calledLast4: lastFour(payload.Called),
    callerLast4: lastFour(payload.Caller),
    dialCallStatus: stringValue(payload, "DialCallStatus"),
    callStatus: stringValue(payload, "CallStatus"),
    messageStatus: stringValue(payload, "MessageStatus") ?? stringValue(payload, "SmsStatus"),
    recordingStatus: stringValue(payload, "RecordingStatus"),
    recordingDuration: stringValue(payload, "RecordingDuration"),
    errorCode: stringValue(payload, "ErrorCode"),
    hasBody: Boolean(body),
    bodyLength: body?.length ?? null,
  };
}

function isMissingCorrelationIdColumnError(error: { message: string } | null) {
  return Boolean(error?.message.includes("correlation_id"));
}

function isMissingAccountIdColumnError(error: { message: string } | null) {
  return Boolean(error?.message.includes("account_id"));
}

export async function getRecentWebhookEventsForAccount(inputAccountId: string, limit = 20) {
  const accountId = assertAccountId(inputAccountId, "getRecentWebhookEventsForAccount");

  if (isPlaceholderSupabaseConfig()) {
    return [] as WebhookEvent[];
  }

  const query = supabaseAdmin
    .from("webhook_events")
    .select("id, account_id, created_at, source, correlation_id, payload, response_status, response_body, error")
    .order("created_at", { ascending: false })
    .eq("account_id", accountId)
    .limit(limit);

  const { data, error } = await query;

  if (error) {
    if (isMissingCorrelationIdColumnError(error)) {
      const legacyQuery = supabaseAdmin
        .from("webhook_events")
        .select("id, created_at, source, payload, response_status, response_body, error")
        .order("created_at", { ascending: false })
        .eq("account_id", accountId)
        .limit(limit);

      const { data: legacyData, error: legacyError } = await legacyQuery;

      if (!legacyError) {
        return (legacyData ?? []).map((event) => ({
          ...event,
          account_id: accountId,
          correlation_id: null,
        })) as WebhookEvent[];
      }
    }

    console.error("Failed to load recent webhook events", error);
    return [] as WebhookEvent[];
  }

  return (data ?? []) as WebhookEvent[];
}

export async function logWebhookEvent(input: {
  accountId?: string | null;
  source: WebhookEventSource;
  correlationId?: string | null;
  payload: Record<string, string>;
  responseStatus: number;
  responseBody?: string | null;
  error?: string | null;
  internalStatus?: "succeeded" | "failed" | "suppressed" | "reconciled";
  providerStatus?: string | null;
  failureCode?: string | null;
  customerExplanation?: string;
  retryEligibility?: "automatic" | "manual" | "never";
  recommendedNextAction?: string;
  customerVisible?: boolean;
}) {
  if (isPlaceholderSupabaseConfig()) {
    return;
  }

  const event = {
    account_id: input.accountId ?? null,
    source: input.source,
    payload: sanitizedWebhookPayload(input.payload),
    response_status: input.responseStatus,
    response_body: input.responseBody ?? null,
    error: input.error ?? null,
  };
  const { error } = await supabaseAdmin.from("webhook_events").insert({
    ...event,
    correlation_id: input.correlationId ?? null,
  });

  if (input.accountId && input.correlationId) {
    try {
      const internalStatus = input.internalStatus
        ?? (input.responseStatus >= 400 ? "failed" : "succeeded");
      await recordProviderAction({
        accountId: input.accountId,
        action: `webhook_${input.source}`,
        provider: "twilio",
        idempotencyKey: `webhook:${input.source}:${input.correlationId}`,
        providerIdentifier: input.correlationId,
        resourceType: "webhook_event",
        resourceId: input.correlationId,
        internalStatus,
        providerStatus: input.providerStatus ?? String(input.responseStatus),
        failureCode: input.failureCode,
        diagnosticDetail: internalStatus === "failed" ? input.error : null,
        customerExplanation: input.customerExplanation
          ?? (internalStatus === "failed"
            ? "Relay received the provider update but could not finish processing it."
            : "Relay processed the provider update."),
        retryEligibility: input.retryEligibility ?? (internalStatus === "failed" ? "automatic" : "never"),
        recommendedNextAction: input.recommendedNextAction
          ?? (internalStatus === "failed"
            ? "Review the sanitized webhook event and replay only the same provider identifier."
            : "No action is needed."),
        customerVisible: input.customerVisible ?? false,
        countAttempt: true,
      });
    } catch (providerActionError) {
      console.error("Failed to record provider action for webhook", {
        accountId: input.accountId,
        source: input.source,
        correlationId: input.correlationId,
        error: providerActionError instanceof Error ? providerActionError.message : providerActionError,
      });
    }
  }

  if (error) {
    if (isMissingCorrelationIdColumnError(error) || isMissingAccountIdColumnError(error)) {
      const legacyEvent = { ...event };
      delete (legacyEvent as Partial<typeof legacyEvent>).account_id;

      const { error: legacyError } = await supabaseAdmin.from("webhook_events").insert(legacyEvent);

      if (!legacyError) {
        return;
      }
    }

    console.error("Failed to log webhook event", {
      correlationId: input.correlationId ?? null,
      error,
    });
  }
}
