import { env } from "@/lib/env";
import { logWebhookEvent } from "@/lib/supabase";
import {
  formDataToRecord,
  logUnsignedTwilioWebhook,
  rejectInvalidTwilioSignature,
  summarizeTwilioRequest,
  validateTwilioWebhook,
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

async function handleForwardingMode(input: {
  request: Request;
  payload: Record<string, string>;
  correlationId: string;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
  validation: ReturnType<typeof validateTwilioWebhook>;
  callerPhone: string;
}) {
  const callSid = input.payload.CallSid ?? "";
  const xml = missedCallTwiml(input.request);

  try {
    const result = await handleMissedCall({
      callSid,
      callerPhone: input.callerPhone,
      message: null,
      correlationId: input.correlationId,
    });

    console.info("Handled forwarded missed call", {
      correlationId: input.correlationId,
      ...input.requestSummary,
      smsStatus: result.smsStatus,
    });

    await logWebhookEvent({
      source: VOICE_WEBHOOK_SOURCE,
      correlationId: input.correlationId,
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
      correlationId: input.correlationId,
      payload: input.payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
    });

    console.error("Failed to handle forwarded missed call", {
      correlationId: input.correlationId,
      ...input.requestSummary,
      error: message,
    });
  }

  return twimlResponse(xml);
}

async function handleDirectMode(input: {
  request: Request;
  payload: Record<string, string>;
  correlationId: string;
  validation: ReturnType<typeof validateTwilioWebhook>;
  callerPhone: string;
}) {
  const xml = directCallTwiml(input.request, input.callerPhone);

  await logWebhookEvent({
    source: VOICE_WEBHOOK_SOURCE,
    correlationId: input.correlationId,
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

export async function GET() {
  return new Response("Twilio voice webhook requires POST.", {
    status: 405,
    headers: {
      Allow: "POST",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const correlationId = payload.CallSid || payload.MessageSid || payload.RecordingSid || crypto.randomUUID();
  const requestSummary = summarizeTwilioRequest(request, payload);
  const validation = validateTwilioWebhook(request, payload);
  const callerPhone = payload.From || env.twilioPhoneNumber;

  console.info("Twilio voice webhook received", { correlationId, ...requestSummary });

  if (validation.shouldReject) {
    return rejectInvalidTwilioSignature({
      source: VOICE_WEBHOOK_SOURCE,
      label: "voice",
      payload,
      correlationId,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
      responseBody: "Rejected invalid Twilio signature for voice webhook.",
    });
  }

  if (validation.wasAllowedByOverride) {
    await logUnsignedTwilioWebhook({
      source: VOICE_WEBHOOK_SOURCE,
      label: "voice",
      payload,
      correlationId,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
      responseBody: "Allowed unsigned Twilio voice webhook by env override.",
    });
  }

  if (env.callMode === "forwarding") {
    return handleForwardingMode({
      request,
      payload,
      correlationId,
      requestSummary,
      validation,
      callerPhone,
    });
  }

  return handleDirectMode({
    request,
    payload,
    correlationId,
    validation,
    callerPhone,
  });
}
