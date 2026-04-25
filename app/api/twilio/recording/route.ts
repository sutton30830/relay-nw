import { env } from "@/lib/env";
import { logWebhookEvent, updateLeadRecordingByCallSid } from "@/lib/supabase";
import {
  formDataToRecord,
  summarizeTwilioRequest,
  twilioWebhookUrls,
  validateTwilioRequest,
} from "@/lib/twilio";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

function parseDuration(value: string | null) {
  if (!value) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordingMediaUrl(value: string | null) {
  if (!value) return null;
  return value.endsWith(".mp3") || value.endsWith(".wav") ? value : `${value}.mp3`;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const candidateUrls = twilioWebhookUrls(request);
  const validation = validateTwilioRequest({
    urls: candidateUrls,
    params: payload,
    signature: request.headers.get("x-twilio-signature"),
  });
  const requestSummary = summarizeTwilioRequest(request, payload);
  const xml = emptyTwiml();

  console.info("Twilio recording webhook received", {
    ...requestSummary,
    recordingSid: payload.RecordingSid ?? null,
    recordingDuration: payload.RecordingDuration ?? null,
  });

  if (!validation.isValid && !env.allowUnsignedTwilioWebhooks) {
    console.warn("Twilio recording signature validation failed", {
      ...requestSummary,
      candidateUrls,
      hasSignature: Boolean(request.headers.get("x-twilio-signature")),
    });

    await logWebhookEvent({
      source: "twilio_recording",
      payload,
      responseStatus: 403,
      responseBody: "Forbidden",
      error: `Invalid Twilio signature. Candidate URLs: ${candidateUrls.join(" | ")}`,
    });

    return new Response("Forbidden", { status: 403 });
  }

  try {
    const callSid = String(formData.get("CallSid") || "").trim();

    if (callSid) {
      await updateLeadRecordingByCallSid({
        callSid,
        recordingSid: String(formData.get("RecordingSid") || "").trim() || null,
        recordingUrl: recordingMediaUrl(String(formData.get("RecordingUrl") || "").trim() || null),
        recordingDuration: parseDuration(String(formData.get("RecordingDuration") || "").trim() || null),
        recordingStatus: String(formData.get("RecordingStatus") || "").trim() || null,
      });
    }

    await logWebhookEvent({
      source: "twilio_recording",
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: validation.matchedUrl
        ? `Validated with URL: ${validation.matchedUrl}`
        : env.allowUnsignedTwilioWebhooks
          ? "Unsigned/invalid Twilio recording webhook allowed by env override."
          : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown recording webhook error";

    await logWebhookEvent({
      source: "twilio_recording",
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
    });

    console.error("Failed to handle Twilio recording webhook", error);
  }

  return twimlResponse(xml);
}
