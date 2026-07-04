import { env } from "@/lib/env";
import { notifyAdminOperationalIssue, notifyOwnerInboundReply, notifyOwnerOptOut } from "@/lib/email";
import { normalizePhoneNumber } from "@/lib/phone";
import {
  assertTenantAccount,
  createInboundMessageIfNew,
  createMessageIfNew,
  clearOptOut,
  logWebhookEvent,
  recordOptOut,
  resolveAccountByTwilioNumber,
  type TenantAccountRuntimeConfig,
  resolveAccountSafely,
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
import { emptyTwiml, helpReplyTwiml, twimlResponse } from "@/lib/twiml";

const INBOUND_SMS_WEBHOOK_SOURCE = "twilio_inbound_sms";
const OPT_OUT_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const OPT_IN_WORDS = new Set(["START", "UNSTOP", "YES"]);
const HELP_WORDS = new Set(["HELP", "INFO"]);

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
    isOptIn: Boolean(from) && OPT_IN_WORDS.has(normalizeBody(body)),
    isHelp: Boolean(from) && HELP_WORDS.has(normalizeBody(body)),
    shouldNotifyOwner: Boolean(from && body),
  };
}

function webhookEventNote(input: {
  matchedUrl: string | null;
  action:
    | "recorded_opt_out"
    | "recorded_opt_in"
    | "answered_help"
    | "notified_owner"
    | "forwarded_to_owner"
    | "sms_disabled"
    | "ignored_empty_message"
    | "ignored_owner_message"
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

  if (input.action === "recorded_opt_in") {
    notes.push("Recorded re-opt-in (START).");
  }

  if (input.action === "answered_help") {
    notes.push("Answered HELP with business info.");
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

  if (input.action === "ignored_owner_message") {
    notes.push("Ignored because the sender is the account owner's phone.");
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

  // The owner now receives Relay texts (new-lead alerts, forwarded replies) from this
  // number. If the owner texts the Relay number back, do not echo-forward their own
  // message to them and do not email them about their own reply.
  if (input.from && input.from === account.ownerPhoneNumber) {
    return "ignored_owner_message" as const;
  }

  if (input.isOptIn) {
    await clearOptOut(input.from, account.accountId);
    return "recorded_opt_in" as const;
  }

  if (input.isHelp) {
    return "answered_help" as const;
  }

  if (input.isOptOut) {
    await recordOptOut(input.from, account.accountId);
    await notifyOwnerOptOut({
      account,
      callerPhone: input.from,
    });
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
  const accountResolution = await resolveAccountSafely(() => resolveAccountByTwilioNumber(message.to || payload.To), "inbound SMS");
  const resolvedAccount = accountResolution.status === "resolved" ? accountResolution.account : null;
  let responseXml = emptyTwiml();

  console.info("Twilio inbound SMS webhook received", {
    correlationId,
    accountId: resolvedAccount?.accountId ?? null,
    accountSlug: resolvedAccount?.accountSlug ?? null,
    accountResolutionStatus: accountResolution.status,
    ...requestSummary,
    hasBody: Boolean(message.body),
    isOptOut: message.isOptOut,
    isOptIn: message.isOptIn,
    isHelp: message.isHelp,
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
      responseBody: responseXml,
    });
  }

  const account = assertTenantAccount(accountResolution.account, "inbound SMS webhook");

  try {
    const action = await handleInboundSms(account, message, correlationId);
    responseXml = action === "answered_help" ? helpReplyTwiml({ businessName: account.businessName }) : emptyTwiml();

    await logWebhookEvent({
      accountId: account.accountId,
      source: INBOUND_SMS_WEBHOOK_SOURCE,
      correlationId,
      payload,
      responseStatus: 200,
      responseBody: responseXml,
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
      responseBody: responseXml,
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

  return twimlResponse(responseXml);
}
