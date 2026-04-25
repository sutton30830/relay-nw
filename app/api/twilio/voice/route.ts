import { env } from "@/lib/env";
import { logWebhookEvent } from "@/lib/supabase";
import {
  formDataToRecord,
  summarizeTwilioRequest,
  twilioWebhookUrls,
  validateTwilioRequest,
} from "@/lib/twilio";
import { handleMissedCall } from "@/lib/missed-call";
import { dialForwardTwiml, forwardedMissedCallTwiml, twimlResponse } from "@/lib/twiml";

function voiceTwiml(request: Request, callerPhone: string) {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const requestOrigin =
    forwardedProto && forwardedHost
      ? `${forwardedProto}://${forwardedHost}`
      : `${url.protocol}//${url.host}`;
  const actionUrl = `${requestOrigin || env.appBaseUrl}/api/twilio/voice-status`;

  return dialForwardTwiml({
    ownerPhoneNumber: env.ownerPhoneNumber,
    callerId: callerPhone,
    actionUrl,
    timeoutSeconds: env.dialTimeoutSeconds,
  });
}

export async function GET(request: Request) {
  const xml = voiceTwiml(request, env.twilioPhoneNumber);
  return twimlResponse(xml);
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const candidateUrls = twilioWebhookUrls(request);
  const signature = request.headers.get("x-twilio-signature");
  const validation = validateTwilioRequest({
    urls: candidateUrls,
    params: payload,
    signature,
  });
  const requestSummary = summarizeTwilioRequest(request, payload);

  console.info("Twilio voice webhook received", requestSummary);

  if (!validation.isValid && !env.allowUnsignedTwilioWebhooks) {
    console.warn("Twilio voice signature validation failed", {
      ...requestSummary,
      candidateUrls,
      hasSignature: Boolean(signature),
    });

    await logWebhookEvent({
      source: "twilio_voice",
      payload,
      responseStatus: 403,
      responseBody: "Rejected invalid Twilio signature for voice webhook.",
      error: `Invalid Twilio signature. Candidate URLs: ${candidateUrls.join(" | ")}`,
    });

    return new Response("Forbidden", { status: 403 });
  }

  if (!validation.isValid) {
    console.warn("Unsigned Twilio voice webhook allowed by env override", {
      ...requestSummary,
      candidateUrls,
      hasSignature: Boolean(signature),
    });

    await logWebhookEvent({
      source: "twilio_voice",
      payload,
      responseStatus: 200,
      responseBody: "Allowed unsigned Twilio voice webhook by env override.",
      error: `Unsigned/invalid Twilio signature. Candidate URLs: ${candidateUrls.join(" | ")}`,
    });
  }

  const callerPhone = String(formData.get("From") || env.twilioPhoneNumber);

  if (env.callMode === "forwarding") {
    const callSid = String(formData.get("CallSid") || "").trim();
    const xml = forwardedMissedCallTwiml();

    try {
      const result = await handleMissedCall({
        callSid,
        callerPhone,
        message: "Forwarded missed call from existing business number.",
      });

      console.info("Handled forwarded missed call", {
        ...requestSummary,
        smsStatus: result.smsStatus,
      });

      await logWebhookEvent({
        source: "twilio_voice",
        payload,
        responseStatus: 200,
        responseBody: xml,
        error: validation.matchedUrl
          ? `Validated with URL: ${validation.matchedUrl}; forwarding mode SMS status: ${result.smsStatus}`
          : env.allowUnsignedTwilioWebhooks
            ? `Unsigned/invalid Twilio webhook allowed by env override; forwarding mode SMS status: ${result.smsStatus}`
            : `Forwarding mode SMS status: ${result.smsStatus}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown forwarding-mode error";

      await logWebhookEvent({
        source: "twilio_voice",
        payload,
        responseStatus: 200,
        responseBody: xml,
        error: message,
      });

      console.error("Failed to handle forwarded missed call", error);
    }

    return twimlResponse(xml);
  }

  const xml = voiceTwiml(request, callerPhone);

  await logWebhookEvent({
    source: "twilio_voice",
    payload,
    responseStatus: 200,
    responseBody: xml,
    error: validation.matchedUrl
      ? `Validated with URL: ${validation.matchedUrl}`
      : env.allowUnsignedTwilioWebhooks
        ? "Unsigned/invalid Twilio webhook allowed by env override."
        : null,
  });

  return twimlResponse(xml);
}
