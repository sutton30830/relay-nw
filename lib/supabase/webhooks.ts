import { env } from "@/lib/env";
import { isPlaceholderSupabaseConfig, supabaseAdmin } from "./client";
import type { WebhookEvent, WebhookEventSource } from "./types";

const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastRetentionSweepAt = 0;

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

function retentionCutoff(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function pruneOldOperationalData() {
  const now = Date.now();

  if (now - lastRetentionSweepAt < RETENTION_SWEEP_INTERVAL_MS) {
    return;
  }

  lastRetentionSweepAt = now;

  const webhookCutoff = retentionCutoff(env.webhookEventRetentionDays);
  const inboundMessageCutoff = retentionCutoff(env.inboundMessageRetentionDays);

  const { error: webhookError } = await supabaseAdmin
    .from("webhook_events")
    .delete()
    .lt("created_at", webhookCutoff);

  if (webhookError) {
    console.error("Failed to prune old webhook events", webhookError);
  }

  const { error: inboundMessageError } = await supabaseAdmin
    .from("inbound_messages")
    .delete()
    .lt("created_at", inboundMessageCutoff);

  if (inboundMessageError) {
    console.error("Failed to prune old inbound messages", inboundMessageError);
  }
}

export async function getRecentWebhookEvents(limit = 20) {
  if (isPlaceholderSupabaseConfig()) {
    return [] as WebhookEvent[];
  }

  const query = supabaseAdmin
    .from("webhook_events")
    .select("id, created_at, source, correlation_id, payload, response_status, response_body, error")
    .order("created_at", { ascending: false })
    .limit(limit);
  const { data, error } = await query;

  if (error) {
    if (isMissingCorrelationIdColumnError(error)) {
      const { data: legacyData, error: legacyError } = await supabaseAdmin
        .from("webhook_events")
        .select("id, created_at, source, payload, response_status, response_body, error")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (!legacyError) {
        return (legacyData ?? []).map((event) => ({
          ...event,
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
  source: WebhookEventSource;
  correlationId?: string | null;
  payload: Record<string, string>;
  responseStatus: number;
  responseBody?: string | null;
  error?: string | null;
}) {
  if (isPlaceholderSupabaseConfig()) {
    return;
  }

  await pruneOldOperationalData();

  const event = {
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

  if (error) {
    if (isMissingCorrelationIdColumnError(error)) {
      const { error: legacyError } = await supabaseAdmin.from("webhook_events").insert(event);

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
