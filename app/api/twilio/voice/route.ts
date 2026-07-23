import { env } from "@/lib/env";
import {
  assertTenantAccount,
  type AccountRuntimeConfig,
  type TenantAccountRuntimeConfig,
  logWebhookEvent,
  resolveAccountByTwilioNumber,
  upsertCall,
  resolveAccountSafely,
} from "@/lib/supabase";
import {
  formDataToRecord,
  logUnsignedTwilioWebhook,
  rejectInvalidTwilioSignature,
  summarizeTwilioRequest,
  validateTwilioWebhook,
} from "@/lib/twilio";
import { handleMissedCall } from "@/lib/missed-call";
import { handleUnresolvedTwilioAccount } from "@/lib/twilio/unresolved-account";
import { dialForwardTwiml, forwardedMissedCallTwiml, twimlResponse } from "@/lib/twiml";

const VOICE_WEBHOOK_SOURCE = "twilio_voice";

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return fallback;
}

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

function directCallTwiml(request: Request, callerPhone: string, account: AccountRuntimeConfig) {
  return dialForwardTwiml({
    ownerPhoneNumber: account.ownerPhoneNumber,
    callerId: callerPhone,
    actionUrl: callbackUrl(request, "/api/twilio/voice-status"),
    timeoutSeconds: account.dialTimeoutSeconds,
  });
}

function missedCallTwiml(request: Request, account: AccountRuntimeConfig) {
  return forwardedMissedCallTwiml({
    message: account.missedCallVoiceMessage ?? undefined,
    voiceName: account.missedCallVoiceName,
    greetingAudioUrl: account.missedCallGreetingAudioUrl ?? undefined,
    recordingActionUrl: callbackUrl(request, "/api/twilio/recording"),
    maxLengthSeconds: account.voicemailMaxSeconds,
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
  account: TenantAccountRuntimeConfig;
  request: Request;
  payload: Record<string, string>;
  correlationId: string;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
  validation: ReturnType<typeof validateTwilioWebhook>;
  callerPhone: string;
  twilioSignatureValid: boolean;
}) {
  const callSid = input.payload.CallSid ?? "";
  const xml = missedCallTwiml(input.request, input.account);

  try {
    await upsertCall({
      accountId: input.account.accountId,
      callSid,
      parentCallSid: input.payload.ParentCallSid ?? null,
      fromPhone: input.callerPhone,
      toPhone: input.payload.To ?? null,
      status: "missed",
      rawSummary: input.requestSummary,
    });

    const result = await handleMissedCall({
      account: input.account,
      callSid,
      callerPhone: input.callerPhone,
      message: null,
      correlationId: input.correlationId,
      twilioSignatureValid: input.twilioSignatureValid,
    });

    console.info("Handled forwarded missed call", {
      correlationId: input.correlationId,
      ...input.requestSummary,
      smsStatus: result.smsStatus,
    });

    await logWebhookEvent({
      accountId: input.account.accountId,
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
    const message = errorMessage(error, "Unknown forwarding-mode error");

    await logWebhookEvent({
      accountId: input.account.accountId,
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
  account: TenantAccountRuntimeConfig;
  request: Request;
  payload: Record<string, string>;
  correlationId: string;
  validation: ReturnType<typeof validateTwilioWebhook>;
  callerPhone: string;
}) {
  const callSid = input.payload.CallSid ?? "";
  const xml = directCallTwiml(input.request, input.callerPhone, input.account);

  try {
    await upsertCall({
      accountId: input.account.accountId,
      callSid,
      parentCallSid: input.payload.ParentCallSid ?? null,
      fromPhone: input.callerPhone,
      toPhone: input.payload.To ?? null,
      status: "ringing",
      rawSummary: summarizeTwilioRequest(input.request, input.payload),
    });

    await logWebhookEvent({
      accountId: input.account.accountId,
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
  } catch (error) {
    const message = errorMessage(error, "Unknown direct-mode voice error");

    console.error("Failed to record direct-mode voice call", {
      correlationId: input.correlationId,
      callSid,
      error: message,
    });

    await logWebhookEvent({
      accountId: input.account.accountId,
      source: VOICE_WEBHOOK_SOURCE,
      correlationId: input.correlationId,
      payload: input.payload,
      responseStatus: 200,
      responseBody: xml,
      error: `Call row upsert failed: ${message}`,
    });
  }

  // Always return TwiML so the caller still gets connected even if bookkeeping failed.
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
  const accountResolution = await resolveAccountSafely(() => resolveAccountByTwilioNumber(payload.To), "voice");
  const resolvedAccount = accountResolution.status === "resolved" ? accountResolution.account : null;

  console.info("Twilio voice webhook received", {
    correlationId,
    accountId: resolvedAccount?.accountId ?? null,
    accountSlug: resolvedAccount?.accountSlug ?? null,
    accountResolutionStatus: accountResolution.status,
    ...requestSummary,
  });

  if (validation.shouldReject) {
    return rejectInvalidTwilioSignature({
      source: VOICE_WEBHOOK_SOURCE,
      accountId: resolvedAccount?.accountId ?? null,
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
      accountId: resolvedAccount?.accountId ?? null,
      label: "voice",
      payload,
      correlationId,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
      responseBody: "Allowed unsigned Twilio voice webhook by env override.",
    });
  }

  if (accountResolution.status === "unresolved") {
    return handleUnresolvedTwilioAccount({
      resolution: accountResolution,
      source: VOICE_WEBHOOK_SOURCE,
      label: "voice",
      payload,
      correlationId,
      responseBody: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">We are unable to route this call right now. Please try again later.</Say>
</Response>`,
    });
  }

  const account = assertTenantAccount(accountResolution.account, "voice webhook");
  const callerPhone = payload.From || account.twilioPhoneNumber;

  if (account.callMode === "forwarding") {
    return handleForwardingMode({
      account,
      request,
      payload,
      correlationId,
      requestSummary,
      validation,
      callerPhone,
      twilioSignatureValid: Boolean(validation.matchedUrl),
    });
  }

  return handleDirectMode({
    account,
    request,
    payload,
    correlationId,
    validation,
    callerPhone,
  });
}
