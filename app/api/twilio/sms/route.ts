import { env } from "@/lib/env";
import { createInboundMessageIfNew, logWebhookEvent, recordOptOut } from "@/lib/supabase";
import {
  formDataToRecord,
  summarizeTwilioRequest,
  twilioClient,
  twilioWebhookUrls,
  validateTwilioRequest,
} from "@/lib/twilio";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

const INBOUND_SMS_WEBHOOK_SOURCE = "twilio_inbound_sms";
const OPT_OUT_WORDS = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

function normalizeBody(value: string) {
  return value.trim().toUpperCase();
}

function validateInboundSmsWebhook(request: Request, payload: Record<string, string>) {
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

function parseInboundSmsPayload(payload: Record<string, string>) {
  const messageSid = (payload.MessageSid ?? payload.SmsSid ?? "").trim();
  const from = (payload.From ?? "").trim();
  const to = (payload.To ?? "").trim();
  const body = (payload.Body ?? "").trim();

  return {
    messageSid,
    from,
    to,
    body,
    isOptOut: Boolean(from) && OPT_OUT_WORDS.has(normalizeBody(body)),
    shouldNotifyOwner: Boolean(from && body),
  };
}

function webhookEventNote(input: {
  matchedUrl: string | null;
  action: "recorded_opt_out" | "forwarded_to_owner" | "ignored_empty_message" | "duplicate_ignored";
}) {
  const notes = [];

  if (input.matchedUrl) {
    notes.push(`Validated with URL: ${input.matchedUrl}`);
  } else if (env.allowUnsignedTwilioWebhooks) {
    notes.push("Unsigned/invalid Twilio SMS webhook allowed by env override.");
  }

  if (input.action === "recorded_opt_out") {
    notes.push("Recorded opt-out.");
  }

  if (input.action === "forwarded_to_owner") {
    notes.push("Forwarded inbound reply to owner.");
  }

  if (input.action === "ignored_empty_message") {
    notes.push("Ignored because From or Body was missing.");
  }

  if (input.action === "duplicate_ignored") {
    notes.push("Duplicate inbound SMS webhook ignored.");
  }

  return notes.join(" ");
}

async function rejectInvalidSignature(input: {
  payload: Record<string, string>;
  requestSummary: ReturnType<typeof summarizeTwilioRequest>;
  candidateUrls: string[];
  hasSignature: boolean;
}) {
  console.warn("Twilio inbound SMS signature validation failed", {
    ...input.requestSummary,
    candidateUrls: input.candidateUrls,
    hasSignature: input.hasSignature,
  });

  await logWebhookEvent({
    source: INBOUND_SMS_WEBHOOK_SOURCE,
    payload: input.payload,
    responseStatus: 403,
    responseBody: "Forbidden",
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
  console.warn("Unsigned Twilio inbound SMS webhook allowed by env override", {
    ...input.requestSummary,
    candidateUrls: input.candidateUrls,
    hasSignature: input.hasSignature,
  });

  await logWebhookEvent({
    source: INBOUND_SMS_WEBHOOK_SOURCE,
    payload: input.payload,
    responseStatus: 200,
    responseBody: "Allowed unsigned Twilio inbound SMS webhook by env override.",
    error: `Unsigned/invalid Twilio signature. Candidate URLs: ${input.candidateUrls.join(" | ")}`,
  });
}

async function handleInboundSms(input: ReturnType<typeof parseInboundSmsPayload>) {
  if (input.messageSid && input.from && input.body) {
    const inboundMessage = await createInboundMessageIfNew({
      messageSid: input.messageSid,
      fromPhone: input.from,
      toPhone: input.to || null,
      body: input.body,
    });

    if (!inboundMessage.inserted) {
      return "duplicate_ignored" as const;
    }
  }

  if (input.isOptOut) {
    await recordOptOut(input.from);
    return "recorded_opt_out" as const;
  }

  if (input.shouldNotifyOwner) {
    await twilioClient.messages.create({
      to: env.ownerPhoneNumber,
      from: env.twilioPhoneNumber,
      body: `Reply from ${input.from}: "${input.body}"`,
    });

    return "forwarded_to_owner" as const;
  }

  return "ignored_empty_message" as const;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const requestSummary = summarizeTwilioRequest(request, payload);
  const validation = validateInboundSmsWebhook(request, payload);
  const message = parseInboundSmsPayload(payload);
  const xml = emptyTwiml();

  console.info("Twilio inbound SMS webhook received", {
    ...requestSummary,
    hasBody: Boolean(message.body),
    isOptOut: message.isOptOut,
  });

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

  try {
    const action = await handleInboundSms(message);

    await logWebhookEvent({
      source: INBOUND_SMS_WEBHOOK_SOURCE,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: webhookEventNote({
        matchedUrl: validation.matchedUrl,
        action,
      }),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown inbound SMS error";

    await logWebhookEvent({
      source: INBOUND_SMS_WEBHOOK_SOURCE,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: errorMessage,
    });

    console.error("Failed to handle inbound Twilio SMS", error);
  }

  return twimlResponse(xml);
}
