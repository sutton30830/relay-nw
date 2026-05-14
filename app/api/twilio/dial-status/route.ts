import { logWebhookEvent } from "@/lib/supabase";
import { env } from "@/lib/env";
import {
  formDataToRecord,
  logUnsignedTwilioWebhook,
  phoneLast4,
  rejectInvalidTwilioSignature,
  summarizeTwilioRequest,
  validateTwilioWebhook,
} from "@/lib/twilio";
import { handleMissedCall } from "@/lib/missed-call";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

const DIAL_STATUS_WEBHOOK_SOURCE = "twilio_dial_status";
const MISSED_DIAL_STATUSES = ["no-answer", "busy", "failed", "canceled"] as const;
const CONNECTED_DIAL_STATUSES = ["completed", "answered"] as const;

function isMissedDialStatus(status: string) {
  return (MISSED_DIAL_STATUSES as readonly string[]).includes(status);
}

function isConnectedDialStatus(status: string) {
  return (CONNECTED_DIAL_STATUSES as readonly string[]).includes(status);
}

function webhookEventNote(input: {
  matchedUrl: string | null;
  dialCallStatus: string;
  smsStatus?: string;
  unhandledStatus?: boolean;
}) {
  const notes = [];

  if (input.matchedUrl) {
    notes.push(`Validated with URL: ${input.matchedUrl}`);
  } else if (env.allowUnsignedTwilioWebhooks) {
    notes.push("Unsigned/invalid Twilio webhook allowed by env override.");
  }

  if (input.dialCallStatus) {
    notes.push(`DialCallStatus: ${input.dialCallStatus}`);
  }

  if (input.smsStatus) {
    notes.push(`SMS status: ${input.smsStatus}`);
  }

  if (input.unhandledStatus) {
    notes.push("Unhandled DialCallStatus.");
  }

  return notes.length > 0 ? notes.join(" ") : null;
}

async function processDialStatus(input: {
  callSid: string;
  callerPhone: string;
  correlationId: string;
  dialCallStatus: string;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
}) {
  console.info("Processing Twilio DialCallStatus", {
    correlationId: input.correlationId,
    ...input.requestSummary,
    dialCallStatus: input.dialCallStatus,
  });

  if (isMissedDialStatus(input.dialCallStatus)) {
    const result = await handleMissedCall({
      callSid: input.callSid,
      callerPhone: input.callerPhone,
      message: `Missed call. Dial status: ${input.dialCallStatus}.`,
      correlationId: input.correlationId,
    });

    console.info("Handled direct-mode missed call", {
      correlationId: input.correlationId,
      ...input.requestSummary,
      dialCallStatus: input.dialCallStatus,
      smsStatus: result.smsStatus,
    });

    return { smsStatus: result.smsStatus, unhandledStatus: false };
  }

  if (isConnectedDialStatus(input.dialCallStatus)) {
    return { smsStatus: null, unhandledStatus: false };
  }

  console.warn(`Unhandled DialCallStatus: ${input.dialCallStatus}`, {
    correlationId: input.correlationId,
  });
  return { smsStatus: null, unhandledStatus: true };
}

export async function GET() {
  return twimlResponse(emptyTwiml());
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const correlationId = payload.CallSid || payload.MessageSid || payload.RecordingSid || crypto.randomUUID();
  const requestSummary = summarizeTwilioRequest(request, payload);
  const validation = validateTwilioWebhook(request, payload);
  const dialCallStatus = payload.DialCallStatus ?? "";
  const callerPhone = (payload.From ?? "").trim();
  const callSid = (payload.CallSid ?? "").trim();
  const xml = emptyTwiml();

  console.info("Twilio dial status webhook received", { correlationId, ...requestSummary });

  if (validation.shouldReject) {
    return rejectInvalidTwilioSignature({
      source: DIAL_STATUS_WEBHOOK_SOURCE,
      label: "dial status",
      payload,
      correlationId,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
      responseBody: "Rejected invalid Twilio signature for dial status webhook.",
    });
  }

  if (validation.wasAllowedByOverride) {
    await logUnsignedTwilioWebhook({
      source: DIAL_STATUS_WEBHOOK_SOURCE,
      label: "dial status",
      payload,
      correlationId,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
      responseBody: "Allowed unsigned Twilio dial status webhook by env override.",
    });
  }

  try {
    const result = await processDialStatus({
      callSid,
      callerPhone,
      correlationId,
      dialCallStatus,
      requestSummary,
    });

    await logWebhookEvent({
      source: DIAL_STATUS_WEBHOOK_SOURCE,
      correlationId,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: webhookEventNote({
        matchedUrl: validation.matchedUrl,
        dialCallStatus,
        smsStatus: result.smsStatus ?? undefined,
        unhandledStatus: result.unhandledStatus,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown dial-status error";

    await logWebhookEvent({
      source: DIAL_STATUS_WEBHOOK_SOURCE,
      correlationId,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
    });

    console.error("Failed to handle Twilio dial status", {
      correlationId,
      ...requestSummary,
      callerLast4: phoneLast4(callerPhone),
      error: message,
    });
  }

  return twimlResponse(xml);
}
