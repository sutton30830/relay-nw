import { env } from "@/lib/env";
import { logWebhookEvent, type SmsStatus, updateLeadSmsStatusByMessageSid } from "@/lib/supabase";
import {
  formDataToRecord,
  summarizeTwilioRequest,
  twilioWebhookUrls,
  validateTwilioRequest,
} from "@/lib/twilio";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

const SMS_STATUS_WEBHOOK_SOURCE = "twilio_sms_status";
const TRACKED_SMS_STATUSES = new Set([
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "undelivered",
]);

function validateSmsStatusWebhook(request: Request, payload: Record<string, string>) {
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

function parseSmsStatusPayload(payload: Record<string, string>) {
  const messageSid = (payload.MessageSid ?? payload.SmsSid ?? "").trim();
  const rawStatus = (payload.MessageStatus ?? payload.SmsStatus ?? "").trim().toLowerCase();
  const smsStatus = TRACKED_SMS_STATUSES.has(rawStatus)
    ? rawStatus as Exclude<SmsStatus, null>
    : null;
  const error = (payload.ErrorMessage ?? payload.ErrorCode ?? "").trim() || null;

  return {
    messageSid,
    rawStatus,
    smsStatus,
    error,
  };
}

function webhookEventNote(input: {
  matchedUrl: string | null;
  messageSid: string;
  rawStatus: string;
  leadUpdated: boolean;
}) {
  const notes = [];

  if (input.matchedUrl) {
    notes.push(`Validated with URL: ${input.matchedUrl}`);
  } else if (env.allowUnsignedTwilioWebhooks) {
    notes.push("Unsigned/invalid Twilio SMS status webhook allowed by env override.");
  }

  if (input.messageSid) {
    notes.push(`MessageSid: ${input.messageSid}`);
  }

  if (input.rawStatus) {
    notes.push(`MessageStatus: ${input.rawStatus}`);
  }

  if (!input.leadUpdated) {
    notes.push("No lead matched this MessageSid.");
  }

  return notes.join(" ");
}

async function rejectInvalidSignature(input: {
  payload: Record<string, string>;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
  candidateUrls: string[];
  hasSignature: boolean;
}) {
  console.warn("Twilio SMS status signature validation failed", {
    ...input.requestSummary,
    candidateUrls: input.candidateUrls,
    hasSignature: input.hasSignature,
  });

  await logWebhookEvent({
    source: SMS_STATUS_WEBHOOK_SOURCE,
    payload: input.payload,
    responseStatus: 403,
    responseBody: "Forbidden",
    error: `Invalid Twilio signature. Candidate URLs: ${input.candidateUrls.join(" | ")}`,
  });

  return new Response("Forbidden", { status: 403 });
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const requestSummary = summarizeTwilioRequest(request, payload);
  const validation = validateSmsStatusWebhook(request, payload);
  const status = parseSmsStatusPayload(payload);
  const xml = emptyTwiml();

  console.info("Twilio SMS status webhook received", {
    ...requestSummary,
    messageSid: status.messageSid,
    messageStatus: status.rawStatus,
  });

  if (validation.shouldReject) {
    return rejectInvalidSignature({
      payload,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
    });
  }

  try {
    const result = status.messageSid && status.smsStatus
      ? await updateLeadSmsStatusByMessageSid({
        twilioMessageSid: status.messageSid,
        smsStatus: status.smsStatus,
        smsError: status.error,
      })
      : { updated: false };

    await logWebhookEvent({
      source: SMS_STATUS_WEBHOOK_SOURCE,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: webhookEventNote({
        matchedUrl: validation.matchedUrl,
        messageSid: status.messageSid,
        rawStatus: status.rawStatus,
        leadUpdated: result.updated,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SMS status error";

    await logWebhookEvent({
      source: SMS_STATUS_WEBHOOK_SOURCE,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
    });

    console.error("Failed to handle Twilio SMS status", error);
  }

  return twimlResponse(xml);
}
