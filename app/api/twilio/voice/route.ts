import { env } from "@/lib/env";
import {
  assertTenantAccount,
  type AccountRuntimeConfig,
  type TenantAccountRuntimeConfig,
  findPendingForwardingHealthCheck,
  logWebhookEvent,
  markForwardingHealthCheckFailed,
  markForwardingHealthCheckPassed,
  resolveAccountByTwilioNumber,
  upsertCall,
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

async function handleForwardingHealthCheck(input: {
  account: TenantAccountRuntimeConfig;
  payload: Record<string, string>;
  correlationId: string;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
}) {
  const healthCheck = await findPendingForwardingHealthCheck(input.account.accountId);

  if (!healthCheck) {
    return null;
  }

  console.info("inbound_forwarded_call_detected", {
    healthCheckId: healthCheck.id,
    correlationId: input.correlationId,
    ...input.requestSummary,
  });

  try {
    await markForwardingHealthCheckPassed({
      accountId: input.account.accountId,
      id: healthCheck.id,
      inboundTwilioCallSid: input.payload.CallSid ?? null,
      rawEventSummary: {
        callSid: input.payload.CallSid ?? null,
        fromLast4: input.requestSummary.fromLast4,
        toLast4: input.requestSummary.toLast4,
        callMode: input.requestSummary.callMode,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown health check webhook error";
    await markForwardingHealthCheckFailed({
      accountId: input.account.accountId,
      id: healthCheck.id,
      failureReason: "webhook_error",
      rawEventSummary: {
        message,
        callSid: input.payload.CallSid ?? null,
      },
    });
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna-Neural">Relay forwarding health check passed. Goodbye.</Say>
  <Hangup />
</Response>`;

  await logWebhookEvent({
    accountId: input.account.accountId,
    source: VOICE_WEBHOOK_SOURCE,
    correlationId: input.correlationId,
    payload: input.payload,
    responseStatus: 200,
    responseBody: xml,
    error: `Forwarding health check matched: ${healthCheck.id}`,
  });

  return twimlResponse(xml);
}

async function handleForwardingMode(input: {
  account: TenantAccountRuntimeConfig;
  request: Request;
  payload: Record<string, string>;
  correlationId: string;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
  validation: ReturnType<typeof validateTwilioWebhook>;
  callerPhone: string;
}) {
  const callSid = input.payload.CallSid ?? "";
  const xml = missedCallTwiml(input.request, input.account);

  await upsertCall({
    accountId: input.account.accountId,
    callSid,
    parentCallSid: input.payload.ParentCallSid ?? null,
    fromPhone: input.callerPhone,
    toPhone: input.payload.To ?? null,
    status: "missed",
    rawSummary: input.requestSummary,
  });

  try {
    const result = await handleMissedCall({
      account: input.account,
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
    const message = error instanceof Error ? error.message : "Unknown forwarding-mode error";

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
  const accountResolution = await resolveAccountByTwilioNumber(payload.To);
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

  const healthCheckResponse =
    account.callMode === "forwarding"
      ? await handleForwardingHealthCheck({
          account,
          payload,
          correlationId,
          requestSummary,
        })
      : null;

  if (healthCheckResponse) {
    return healthCheckResponse;
  }

  if (account.callMode === "forwarding") {
    return handleForwardingMode({
      account,
      request,
      payload,
      correlationId,
      requestSummary,
      validation,
      callerPhone,
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
