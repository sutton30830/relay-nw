import { env } from "@/lib/env";
import {
  assertTenantAccount,
  logWebhookEvent,
  resolveAccountByMessageSid,
  type SmsStatus,
  updateLeadSmsStatusByMessageSid,
  updateMessageStatusBySid,
} from "@/lib/supabase";
import {
  formDataToRecord,
  rejectInvalidTwilioSignature,
  summarizeTwilioRequest,
  validateTwilioWebhook,
} from "@/lib/twilio";
import { handleUnresolvedTwilioAccount } from "@/lib/twilio/unresolved-account";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

const SMS_STATUS_WEBHOOK_SOURCE = "twilio_sms_status";
const TRACKED_SMS_STATUSES = new Set([
  "queued",
  "sending",
  "sent",
  "delivered",
  "failed",
  "undelivered",
]);

function parseSmsStatusPayload(payload: Record<string, string>) {
  const messageSid = (payload.MessageSid ?? payload.SmsSid ?? "").trim();
  const rawStatus = (payload.MessageStatus ?? payload.SmsStatus ?? "").trim().toLowerCase();
  const smsStatus = TRACKED_SMS_STATUSES.has(rawStatus)
    ? rawStatus as Exclude<SmsStatus, null>
    : null;
  const error = (payload.ErrorMessage ?? payload.ErrorCode ?? "").trim() || null;

  return {
    messageSid,
    rawStatus,
    smsStatus,
    error,
  };
}

function webhookEventNote(input: {
  matchedUrl: string | null;
  messageSid: string;
  rawStatus: string;
  leadUpdated: boolean;
}) {
  const notes = [];

  if (input.matchedUrl) {
    notes.push(`Validated with URL: ${input.matchedUrl}`);
  } else if (env.allowUnsignedTwilioWebhooks) {
    notes.push("Unsigned/invalid Twilio SMS status webhook allowed by env override.");
  }

  if (input.messageSid) {
    notes.push(`MessageSid: ${input.messageSid}`);
  }

  if (input.rawStatus) {
    notes.push(`MessageStatus: ${input.rawStatus}`);
  }

  if (!input.leadUpdated) {
    notes.push("No lead matched this MessageSid.");
  }

  return notes.join(" ");
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const correlationId = payload.CallSid || payload.MessageSid || payload.RecordingSid || crypto.randomUUID();
  const requestSummary = summarizeTwilioRequest(request, payload);
  const validation = validateTwilioWebhook(request, payload);
  const status = parseSmsStatusPayload(payload);
  const accountResolution = await resolveAccountByMessageSid(status.messageSid);
  const resolvedAccount = accountResolution.status === "resolved" ? accountResolution.account : null;
  const xml = emptyTwiml();

  console.info("Twilio SMS status webhook received", {
    correlationId,
    accountId: resolvedAccount?.accountId ?? null,
    accountSlug: resolvedAccount?.accountSlug ?? null,
    accountResolutionStatus: accountResolution.status,
    ...requestSummary,
    messageSid: status.messageSid,
    messageStatus: status.rawStatus,
  });

  if (validation.shouldReject) {
    return rejectInvalidTwilioSignature({
      source: SMS_STATUS_WEBHOOK_SOURCE,
      accountId: resolvedAccount?.accountId ?? null,
      label: "SMS status",
      payload,
      correlationId,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
    });
  }

  if (accountResolution.status === "unresolved") {
    return handleUnresolvedTwilioAccount({
      resolution: accountResolution,
      source: SMS_STATUS_WEBHOOK_SOURCE,
      label: "SMS status",
      payload,
      correlationId,
      responseBody: xml,
    });
  }

  const account = assertTenantAccount(accountResolution.account, "SMS status webhook");

  try {
    const result = status.messageSid && status.smsStatus
      ? await updateLeadSmsStatusByMessageSid({
        accountId: account.accountId,
        twilioMessageSid: status.messageSid,
        smsStatus: status.smsStatus,
        smsError: status.error,
      })
      : { updated: false };

    if (status.messageSid && status.smsStatus) {
      await updateMessageStatusBySid({
        accountId: account.accountId,
        twilioMessageSid: status.messageSid,
        status: status.smsStatus,
        error: status.error,
      });
    }

    await logWebhookEvent({
      accountId: account.accountId,
      source: SMS_STATUS_WEBHOOK_SOURCE,
      correlationId,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: webhookEventNote({
        matchedUrl: validation.matchedUrl,
        messageSid: status.messageSid,
        rawStatus: status.rawStatus,
        leadUpdated: result.updated,
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SMS status error";

    await logWebhookEvent({
      accountId: account.accountId,
      source: SMS_STATUS_WEBHOOK_SOURCE,
      correlationId,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
    });

    console.error("Failed to handle Twilio SMS status", {
      correlationId,
      ...requestSummary,
      error: message,
    });
  }

  return twimlResponse(xml);
}
