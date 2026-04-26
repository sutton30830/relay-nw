import { logWebhookEvent } from "@/lib/supabase";
import { env } from "@/lib/env";
import {
  formDataToRecord,
  summarizeTwilioRequest,
  twilioWebhookUrls,
  validateTwilioRequest,
} from "@/lib/twilio";
import { handleMissedCall } from "@/lib/missed-call";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

const DIAL_STATUS_WEBHOOK_SOURCE = "twilio_dial_status";
const MISSED_DIAL_STATUSES = ["no-answer", "busy", "failed", "canceled"] as const;
const CONNECTED_DIAL_STATUSES = ["completed", "answered"] as const;

function validateDialStatusWebhook(request: Request, payload: Record<string, string>) {
  const candidateUrls = twilioWebhookUrls(request);
  const signature = request.headers.get("x-twilio-signature");
  const validation = validateTwilioRequest({
    urls: candidateUrls,
    params: payload,
    signature,
  });

  return {
    ...validation,
    candidateUrls,
    hasSignature: Boolean(signature),
    shouldReject: !validation.isValid && !env.allowUnsignedTwilioWebhooks,
    wasAllowedByOverride: !validation.isValid && env.allowUnsignedTwilioWebhooks,
  };
}

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

async function rejectInvalidSignature(input: {
  payload: Record<string, string>;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
  candidateUrls: string[];
  hasSignature: boolean;
}) {
  console.warn("Twilio dial status signature validation failed", {
    ...input.requestSummary,
    candidateUrls: input.candidateUrls,
    hasSignature: input.hasSignature,
  });

  await logWebhookEvent({
    source: DIAL_STATUS_WEBHOOK_SOURCE,
    payload: input.payload,
    responseStatus: 403,
    responseBody: "Rejected invalid Twilio signature for dial status webhook.",
    error: `Invalid Twilio signature. Candidate URLs: ${input.candidateUrls.join(" | ")}`,
  });

  return new Response("Forbidden", { status: 403 });
}

async function logUnsignedOverride(input: {
  payload: Record<string, string>;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
  candidateUrls: string[];
  hasSignature: boolean;
}) {
  console.warn("Unsigned Twilio dial status webhook allowed by env override", {
    ...input.requestSummary,
    candidateUrls: input.candidateUrls,
    hasSignature: input.hasSignature,
  });

  await logWebhookEvent({
    source: DIAL_STATUS_WEBHOOK_SOURCE,
    payload: input.payload,
    responseStatus: 200,
    responseBody: "Allowed unsigned Twilio dial status webhook by env override.",
    error: `Unsigned/invalid Twilio signature. Candidate URLs: ${input.candidateUrls.join(" | ")}`,
  });
}

async function processDialStatus(input: {
  callSid: string;
  callerPhone: string;
  dialCallStatus: string;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
}) {
  console.info("Processing Twilio DialCallStatus", {
    ...input.requestSummary,
    dialCallStatus: input.dialCallStatus,
  });

  if (isMissedDialStatus(input.dialCallStatus)) {
    const result = await handleMissedCall({
      callSid: input.callSid,
      callerPhone: input.callerPhone,
      message: `Missed call. Dial status: ${input.dialCallStatus}.`,
    });

    console.info("Handled direct-mode missed call", {
      ...input.requestSummary,
      dialCallStatus: input.dialCallStatus,
      smsStatus: result.smsStatus,
    });

    return { smsStatus: result.smsStatus, unhandledStatus: false };
  }

  if (isConnectedDialStatus(input.dialCallStatus)) {
    return { smsStatus: null, unhandledStatus: false };
  }

  console.warn(`Unhandled DialCallStatus: ${input.dialCallStatus}`);
  return { smsStatus: null, unhandledStatus: true };
}

export async function GET() {
  return twimlResponse(emptyTwiml());
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const requestSummary = summarizeTwilioRequest(request, payload);
  const validation = validateDialStatusWebhook(request, payload);
  const dialCallStatus = payload.DialCallStatus ?? "";
  const callerPhone = (payload.From ?? "").trim();
  const callSid = (payload.CallSid ?? "").trim();
  const xml = emptyTwiml();

  console.info("Twilio dial status webhook received", requestSummary);

  if (validation.shouldReject) {
    return rejectInvalidSignature({
      payload,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
    });
  }

  if (validation.wasAllowedByOverride) {
    await logUnsignedOverride({
      payload,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
    });
  }

  try {
    const result = await processDialStatus({
      callSid,
      callerPhone,
      dialCallStatus,
      requestSummary,
    });

    await logWebhookEvent({
      source: DIAL_STATUS_WEBHOOK_SOURCE,
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
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
    });

    console.error("Failed to handle Twilio dial status", error);
  }

  return twimlResponse(xml);
}
