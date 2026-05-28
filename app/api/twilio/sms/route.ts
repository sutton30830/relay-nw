import { env } from "@/lib/env";
import { notifyAdminOperationalIssue, notifyOwnerInboundReply } from "@/lib/email";
import { normalizePhoneNumber } from "@/lib/phone";
import {
  assertTenantAccount,
  createInboundMessageIfNew,
  createMessageIfNew,
  logWebhookEvent,
  recordOptOut,
  resolveAccountByTwilioNumber,
  type TenantAccountRuntimeConfig,
} from "@/lib/supabase";
import {
  formDataToRecord,
  logUnsignedTwilioWebhook,
  phoneLast4,
  rejectInvalidTwilioSignature,
  summarizeTwilioRequest,
  twilioClient,
  validateTwilioWebhook,
} from "@/lib/twilio";
import { handleUnresolvedTwilioAccount } from "@/lib/twilio/unresolved-account";
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
    | "notified_owner"
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

  if (input.action === "notified_owner") {
    notes.push("Notified owner by email.");
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

async function handleInboundSms(
  account: TenantAccountRuntimeConfig,
  input: ReturnType<typeof parseInboundSmsPayload>,
  correlationId: string,
) {
  if (input.messageSid && input.from && input.body) {
    const inboundMessage = await createInboundMessageIfNew({
      accountId: account.accountId,
      messageSid: input.messageSid,
      fromPhone: input.from,
      toPhone: input.to || null,
      body: input.body,
    });

    if (!inboundMessage.inserted) {
      return "duplicate_ignored" as const;
    }

    await createMessageIfNew({
      accountId: account.accountId,
      twilioMessageSid: input.messageSid,
      direction: "inbound",
      fromPhone: input.from,
      toPhone: input.to || null,
      body: input.body,
      status: "received",
    });
  }

  if (input.isOptOut) {
    await recordOptOut(input.from, account.accountId);
    return "recorded_opt_out" as const;
  }

  if (input.shouldNotifyOwner) {
    await notifyOwnerInboundReply({
      account,
      callerPhone: input.from,
      body: input.body,
    });
  }

  if (input.shouldNotifyOwner && !account.smsEnabled) {
    console.info("Inbound SMS owner notification suppressed because SMS_ENABLED is false", {
      correlationId,
      fromLast4: phoneLast4(input.from),
      toLast4: phoneLast4(input.to),
    });

    return "notified_owner" as const;
  }

  if (input.shouldNotifyOwner) {
    await twilioClient.messages.create({
      to: account.ownerPhoneNumber,
      from: account.twilioPhoneNumber,
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
  const accountResolution = await resolveAccountByTwilioNumber(message.to || payload.To);
  const resolvedAccount = accountResolution.status === "resolved" ? accountResolution.account : null;
  const xml = emptyTwiml();

  console.info("Twilio inbound SMS webhook received", {
    correlationId,
    accountId: resolvedAccount?.accountId ?? null,
    accountSlug: resolvedAccount?.accountSlug ?? null,
    accountResolutionStatus: accountResolution.status,
    ...requestSummary,
    hasBody: Boolean(message.body),
    isOptOut: message.isOptOut,
  });

  if (validation.shouldReject) {
    return rejectInvalidTwilioSignature({
      source: INBOUND_SMS_WEBHOOK_SOURCE,
      accountId: resolvedAccount?.accountId ?? null,
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
      accountId: resolvedAccount?.accountId ?? null,
      label: "inbound SMS",
      payload,
      correlationId,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
      responseBody: "Allowed unsigned Twilio inbound SMS webhook by env override.",
    });
  }

  if (accountResolution.status === "unresolved") {
    return handleUnresolvedTwilioAccount({
      resolution: accountResolution,
      source: INBOUND_SMS_WEBHOOK_SOURCE,
      label: "inbound SMS",
      payload,
      correlationId,
      responseBody: xml,
    });
  }

  const account = assertTenantAccount(accountResolution.account, "inbound SMS webhook");

  try {
    const action = await handleInboundSms(account, message, correlationId);

    await logWebhookEvent({
      accountId: account.accountId,
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
      accountId: account.accountId,
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
    await notifyAdminOperationalIssue({
      account,
      issue: "Inbound SMS handling failed",
      detail: errorMessage,
      correlationId,
    });
  }

  return twimlResponse(xml);
}
