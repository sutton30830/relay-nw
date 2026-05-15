import { env } from "@/lib/env";
import { normalizePhoneNumber } from "@/lib/phone";
import { createInboundMessageIfNew, logWebhookEvent, recordOptOut } from "@/lib/supabase";
import {
  formDataToRecord,
  logUnsignedTwilioWebhook,
  phoneLast4,
  rejectInvalidTwilioSignature,
  summarizeTwilioRequest,
  twilioClient,
  validateTwilioWebhook,
} from "@/lib/twilio";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

const INBOUND_SMS_WEBHOOK_SOURCE = "twilio_inbound_sms";
const OPT_OUT_WORDS = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

function normalizeBody(value: string) {
  return value.trim().toUpperCase();
}

function parseInboundSmsPayload(payload: Record<string, string>) {
  const messageSid = (payload.MessageSid ?? payload.SmsSid ?? "").trim();
  const from = normalizePhoneNumber(payload.From ?? "");
  const to = normalizePhoneNumber(payload.To ?? "");
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
  action:
    | "recorded_opt_out"
    | "forwarded_to_owner"
    | "sms_disabled"
    | "ignored_empty_message"
    | "duplicate_ignored";
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

  if (input.action === "sms_disabled") {
    notes.push("Owner SMS notification skipped because SMS_ENABLED is false.");
  }

  if (input.action === "ignored_empty_message") {
    notes.push("Ignored because From or Body was missing.");
  }

  if (input.action === "duplicate_ignored") {
    notes.push("Duplicate inbound SMS webhook ignored.");
  }

  return notes.join(" ");
}

async function handleInboundSms(input: ReturnType<typeof parseInboundSmsPayload>, correlationId: string) {
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

  if (input.shouldNotifyOwner && !env.smsEnabled) {
    console.info("Inbound SMS owner notification suppressed because SMS_ENABLED is false", {
      correlationId,
      fromLast4: phoneLast4(input.from),
      toLast4: phoneLast4(input.to),
    });

    return "sms_disabled" as const;
  }

  if (input.shouldNotifyOwner) {
    await twilioClient.messages.create({
      to: env.ownerPhoneNumber,
      from: env.twilioPhoneNumber,
      body: `New Relay reply from ${input.from}:\n${input.body}\n\nOpen leads: ${env.appBaseUrl}/leads`,
    });

    return "forwarded_to_owner" as const;
  }

  return "ignored_empty_message" as const;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const correlationId = payload.CallSid || payload.MessageSid || payload.RecordingSid || crypto.randomUUID();
  const requestSummary = summarizeTwilioRequest(request, payload);
  const validation = validateTwilioWebhook(request, payload);
  const message = parseInboundSmsPayload(payload);
  const xml = emptyTwiml();

  console.info("Twilio inbound SMS webhook received", {
    correlationId,
    ...requestSummary,
    hasBody: Boolean(message.body),
    isOptOut: message.isOptOut,
  });

  if (validation.shouldReject) {
    return rejectInvalidTwilioSignature({
      source: INBOUND_SMS_WEBHOOK_SOURCE,
      label: "inbound SMS",
      payload,
      correlationId,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
    });
  }

  if (validation.wasAllowedByOverride) {
    await logUnsignedTwilioWebhook({
      source: INBOUND_SMS_WEBHOOK_SOURCE,
      label: "inbound SMS",
      payload,
      correlationId,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
      responseBody: "Allowed unsigned Twilio inbound SMS webhook by env override.",
    });
  }

  try {
    const action = await handleInboundSms(message, correlationId);

    await logWebhookEvent({
      source: INBOUND_SMS_WEBHOOK_SOURCE,
      correlationId,
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
      correlationId,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: errorMessage,
    });

    console.error("Failed to handle inbound Twilio SMS", {
      correlationId,
      ...requestSummary,
      error: errorMessage,
    });
  }

  return twimlResponse(xml);
}
