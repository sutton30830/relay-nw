import { env } from "@/lib/env";
import { logWebhookEvent } from "@/lib/supabase";
import {
  formDataToRecord,
  summarizeTwilioRequest,
  twilioWebhookUrls,
  validateTwilioRequest,
} from "@/lib/twilio";
import { dialForwardTwiml, twimlResponse } from "@/lib/twiml";

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

  if (signature && !validation.isValid) {
    console.warn("Twilio voice signature validation failed", {
      ...requestSummary,
      candidateUrls,
      hasSignature: Boolean(signature),
    });

    await logWebhookEvent({
      source: "twilio_voice",
      payload,
      responseStatus: 200,
      responseBody: "Bypassed invalid Twilio signature for voice webhook.",
      error: `Invalid Twilio signature. Candidate URLs: ${candidateUrls.join(" | ")}`,
    });
  }

  const callerPhone = String(formData.get("From") || env.twilioPhoneNumber);
  const xml = voiceTwiml(request, callerPhone);

  await logWebhookEvent({
    source: "twilio_voice",
    payload,
    responseStatus: 200,
    responseBody: xml,
    error: signature
      ? validation.matchedUrl
        ? `Validated with URL: ${validation.matchedUrl}`
        : null
      : "No Twilio signature present; served TwiML for manual testing.",
  });

  return twimlResponse(xml);
}
