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

const VOICE_WEBHOOK_SOURCE = "twilio_voice";

function callbackUrl(request: Request, path: string) {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const requestOrigin =
    forwardedProto && forwardedHost
      ? `${forwardedProto}://${forwardedHost}`
      : `${url.protocol}//${url.host}`;

  return `${requestOrigin || env.appBaseUrl}${path}`;
}

function directCallTwiml(request: Request, callerPhone: string) {
  return dialForwardTwiml({
    ownerPhoneNumber: env.ownerPhoneNumber,
    callerId: callerPhone,
    actionUrl: callbackUrl(request, "/api/twilio/voice-status"),
    timeoutSeconds: env.dialTimeoutSeconds,
  });
}

function missedCallTwiml(request: Request) {
  return forwardedMissedCallTwiml({
    message: env.missedCallVoiceMessage,
    voiceName: env.missedCallVoiceName,
    greetingAudioUrl: env.missedCallGreetingAudioUrl,
    recordingActionUrl: callbackUrl(request, "/api/twilio/recording"),
    maxLengthSeconds: env.voicemailMaxSeconds,
  });
}

function validationLogNote(input: {
  matchedUrl: string | null;
  candidateUrls: string[];
  smsStatus?: string;
}) {
  if (input.matchedUrl) {
    return input.smsStatus
      ? `Validated with URL: ${input.matchedUrl}; forwarding mode SMS status: ${input.smsStatus}`
      : `Validated with URL: ${input.matchedUrl}`;
  }

  if (env.allowUnsignedTwilioWebhooks) {
    return input.smsStatus
      ? `Unsigned/invalid Twilio webhook allowed by env override; forwarding mode SMS status: ${input.smsStatus}`
      : "Unsigned/invalid Twilio webhook allowed by env override.";
  }

  return input.smsStatus ? `Forwarding mode SMS status: ${input.smsStatus}` : null;
}

function validateVoiceWebhook(request: Request, payload: Record<string, string>) {
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

async function rejectInvalidSignature(input: {
  payload: Record<string, string>;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
  candidateUrls: string[];
  hasSignature: boolean;
}) {
  console.warn("Twilio voice signature validation failed", {
    ...input.requestSummary,
    candidateUrls: input.candidateUrls,
    hasSignature: input.hasSignature,
  });

  await logWebhookEvent({
    source: VOICE_WEBHOOK_SOURCE,
    payload: input.payload,
    responseStatus: 403,
    responseBody: "Rejected invalid Twilio signature for voice webhook.",
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
  console.warn("Unsigned Twilio voice webhook allowed by env override", {
    ...input.requestSummary,
    candidateUrls: input.candidateUrls,
    hasSignature: input.hasSignature,
  });

  await logWebhookEvent({
    source: VOICE_WEBHOOK_SOURCE,
    payload: input.payload,
    responseStatus: 200,
    responseBody: "Allowed unsigned Twilio voice webhook by env override.",
    error: `Unsigned/invalid Twilio signature. Candidate URLs: ${input.candidateUrls.join(" | ")}`,
  });
}

async function handleForwardingMode(input: {
  request: Request;
  payload: Record<string, string>;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
  validation: ReturnType<typeof validateVoiceWebhook>;
  callerPhone: string;
}) {
  const callSid = input.payload.CallSid ?? "";
  const xml = missedCallTwiml(input.request);

  try {
    const result = await handleMissedCall({
      callSid,
      callerPhone: input.callerPhone,
      message: "Forwarded missed call from existing business number.",
    });

    console.info("Handled forwarded missed call", {
      ...input.requestSummary,
      smsStatus: result.smsStatus,
    });

    await logWebhookEvent({
      source: VOICE_WEBHOOK_SOURCE,
      payload: input.payload,
      responseStatus: 200,
      responseBody: xml,
      error: validationLogNote({
        matchedUrl: input.validation.matchedUrl,
        candidateUrls: input.validation.candidateUrls,
        smsStatus: result.smsStatus,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown forwarding-mode error";

    await logWebhookEvent({
      source: VOICE_WEBHOOK_SOURCE,
      payload: input.payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
    });

    console.error("Failed to handle forwarded missed call", error);
  }

  return twimlResponse(xml);
}

async function handleDirectMode(input: {
  request: Request;
  payload: Record<string, string>;
  validation: ReturnType<typeof validateVoiceWebhook>;
  callerPhone: string;
}) {
  const xml = directCallTwiml(input.request, input.callerPhone);

  await logWebhookEvent({
    source: VOICE_WEBHOOK_SOURCE,
    payload: input.payload,
    responseStatus: 200,
    responseBody: xml,
    error: validationLogNote({
      matchedUrl: input.validation.matchedUrl,
      candidateUrls: input.validation.candidateUrls,
    }),
  });

  return twimlResponse(xml);
}

export async function GET(request: Request) {
  const xml =
    env.callMode === "forwarding"
      ? missedCallTwiml(request)
      : directCallTwiml(request, env.twilioPhoneNumber);

  return twimlResponse(xml);
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const requestSummary = summarizeTwilioRequest(request, payload);
  const validation = validateVoiceWebhook(request, payload);
  const callerPhone = payload.From || env.twilioPhoneNumber;

  console.info("Twilio voice webhook received", requestSummary);

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

  if (env.callMode === "forwarding") {
    return handleForwardingMode({
      request,
      payload,
      requestSummary,
      validation,
      callerPhone,
    });
  }

  return handleDirectMode({
    request,
    payload,
    validation,
    callerPhone,
  });
}
