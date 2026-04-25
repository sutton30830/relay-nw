import {
  logWebhookEvent,
} from "@/lib/supabase";
import { env } from "@/lib/env";
import {
  formDataToRecord,
  summarizeTwilioRequest,
  twilioWebhookUrls,
  validateTwilioRequest,
} from "@/lib/twilio";
import { handleMissedCall } from "@/lib/missed-call";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

export async function GET() {
  return twimlResponse(emptyTwiml());
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

  console.info("Twilio dial status webhook received", requestSummary);

  if (!validation.isValid && !env.allowUnsignedTwilioWebhooks) {
    console.warn("Twilio dial status signature validation failed", {
      ...requestSummary,
      candidateUrls,
      hasSignature: Boolean(request.headers.get("x-twilio-signature")),
    });

    await logWebhookEvent({
      source: "twilio_dial_status",
      payload,
      responseStatus: 403,
      responseBody: "Rejected invalid Twilio signature for dial status webhook.",
      error: `Invalid Twilio signature. Candidate URLs: ${candidateUrls.join(" | ")}`,
    });

    return new Response("Forbidden", { status: 403 });
  }

  if (!validation.isValid) {
    console.warn("Unsigned Twilio dial status webhook allowed by env override", {
      ...requestSummary,
      candidateUrls,
      hasSignature: Boolean(request.headers.get("x-twilio-signature")),
    });

    await logWebhookEvent({
      source: "twilio_dial_status",
      payload,
      responseStatus: 200,
      responseBody: "Allowed unsigned Twilio dial status webhook by env override.",
      error: `Unsigned/invalid Twilio signature. Candidate URLs: ${candidateUrls.join(" | ")}`,
    });
  }

  const dialCallStatus = String(formData.get("DialCallStatus") || "");
  const callerPhone = String(formData.get("From") || "").trim();
  const callSid = String(formData.get("CallSid") || "").trim();
  const xml = emptyTwiml();

  try {
    console.info("Processing Twilio DialCallStatus", {
      ...requestSummary,
      dialCallStatus,
    });

    switch (dialCallStatus) {
      case "no-answer":
      case "busy":
      case "failed":
      case "canceled": {
        const result = await handleMissedCall({
          callSid,
          callerPhone,
          message: `Missed call. Dial status: ${dialCallStatus}.`,
        });

        console.info("Handled direct-mode missed call", {
          ...requestSummary,
          dialCallStatus,
          smsStatus: result.smsStatus,
        });

        break;
      }
      case "completed":
      case "answered":
        break;
      default:
        console.warn(`Unhandled DialCallStatus: ${dialCallStatus}`);
        break;
    }

    await logWebhookEvent({
      source: "twilio_dial_status",
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: validation.matchedUrl ? `Validated with URL: ${validation.matchedUrl}` : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown dial-status error";

    await logWebhookEvent({
      source: "twilio_dial_status",
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
    });

    console.error("Failed to handle Twilio dial status", error);
  }

  return twimlResponse(xml);
}
