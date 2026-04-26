import { env } from "@/lib/env";
import { logWebhookEvent, updateLeadRecordingByCallSid } from "@/lib/supabase";
import {
  formDataToRecord,
  summarizeTwilioRequest,
  twilioWebhookUrls,
  validateTwilioRequest,
} from "@/lib/twilio";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

const RECORDING_WEBHOOK_SOURCE = "twilio_recording";

function parseDuration(value: string | null) {
  if (!value) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordingMediaUrl(value: string | null) {
  if (!value) return null;
  return value.endsWith(".mp3") || value.endsWith(".wav") ? value : `${value}.mp3`;
}

function validateRecordingWebhook(request: Request, payload: Record<string, string>) {
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

function parseRecordingPayload(payload: Record<string, string>) {
  return {
    callSid: (payload.CallSid ?? "").trim(),
    recordingSid: (payload.RecordingSid ?? "").trim() || null,
    recordingUrl: recordingMediaUrl((payload.RecordingUrl ?? "").trim() || null),
    recordingDuration: parseDuration((payload.RecordingDuration ?? "").trim() || null),
    recordingStatus: (payload.RecordingStatus ?? "").trim() || null,
  };
}

function webhookEventNote(input: {
  matchedUrl: string | null;
  recordingUpdated: boolean;
  missingCallSid: boolean;
}) {
  const notes = [];

  if (input.matchedUrl) {
    notes.push(`Validated with URL: ${input.matchedUrl}`);
  } else if (env.allowUnsignedTwilioWebhooks) {
    notes.push("Unsigned/invalid Twilio recording webhook allowed by env override.");
  }

  if (input.recordingUpdated) {
    notes.push("Recording attached to lead.");
  }

  if (input.missingCallSid) {
    notes.push("Skipped recording update because CallSid was missing.");
  }

  return notes.length > 0 ? notes.join(" ") : null;
}

async function rejectInvalidSignature(input: {
  payload: Record<string, string>;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
  candidateUrls: string[];
  hasSignature: boolean;
}) {
  console.warn("Twilio recording signature validation failed", {
    ...input.requestSummary,
    candidateUrls: input.candidateUrls,
    hasSignature: input.hasSignature,
  });

  await logWebhookEvent({
    source: RECORDING_WEBHOOK_SOURCE,
    payload: input.payload,
    responseStatus: 403,
    responseBody: "Forbidden",
    error: `Invalid Twilio signature. Candidate URLs: ${input.candidateUrls.join(" | ")}`,
  });

  return new Response("Forbidden", { status: 403 });
}

async function updateLeadRecording(input: ReturnType<typeof parseRecordingPayload>) {
  if (!input.callSid) {
    console.warn("Skipping recording update because CallSid was missing", {
      recordingSid: input.recordingSid,
      recordingStatus: input.recordingStatus,
    });

    return { updated: false, missingCallSid: true };
  }

  await updateLeadRecordingByCallSid(input);
  return { updated: true, missingCallSid: false };
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const requestSummary = summarizeTwilioRequest(request, payload);
  const validation = validateRecordingWebhook(request, payload);
  const recording = parseRecordingPayload(payload);
  const xml = emptyTwiml();

  console.info("Twilio recording webhook received", {
    ...requestSummary,
    recordingSid: recording.recordingSid,
    recordingDuration: recording.recordingDuration,
    recordingStatus: recording.recordingStatus,
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
    const result = await updateLeadRecording(recording);

    await logWebhookEvent({
      source: RECORDING_WEBHOOK_SOURCE,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: webhookEventNote({
        matchedUrl: validation.matchedUrl,
        recordingUpdated: result.updated,
        missingCallSid: result.missingCallSid,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown recording webhook error";

    await logWebhookEvent({
      source: RECORDING_WEBHOOK_SOURCE,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
    });

    console.error("Failed to handle Twilio recording webhook", error);
  }

  return twimlResponse(xml);
}
