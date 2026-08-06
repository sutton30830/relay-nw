import { env } from "@/lib/env";
import {
  assertTenantAccount,
  getAccountConfigByAccountId,
  getOutboundMessageLeadIdBySid,
  logWebhookEvent,
  resolveAccountByMessageSid,
  resolveConsistentAccountEvidence,
  type SmsStatus,
  updateLeadSmsStatus,
  updateLeadSmsStatusByMessageSid,
  updateMessageStatusBySid,
  resolveAccountSafely,
  recordSmsOnboardingEvidence,
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

function providerErrorCode(error: string | null | undefined) {
  return error?.match(/\b(?:21|30)\d{3}\b/)?.[0] ?? null;
}

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

function parseCallbackContext(request: Request) {
  const url = new URL(request.url);
  const messageType = url.searchParams.get("messageType") === "manual_reply"
    ? "manual_reply" as const
    : "auto_text" as const;

  return {
    messageType,
    accountId: url.searchParams.get("accountId")?.trim() || null,
  };
}

function webhookEventNote(input: {
  matchedUrl: string | null;
  messageSid: string;
  rawStatus: string;
  leadUpdated: boolean;
  reconciledLeadId?: string | null;
  messageType: "auto_text" | "manual_reply";
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

  if (input.messageType === "manual_reply") {
    notes.push("Manual reply status updated on its message row.");
  } else if (input.reconciledLeadId) {
    notes.push(
      `Lead was stale (missing MessageSid after a partial failure); reconciled lead ${input.reconciledLeadId} to Twilio status via messages table.`,
    );
  } else if (!input.leadUpdated) {
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
  const callback = parseCallbackContext(request);
  const accountResolution = await resolveAccountSafely(async () => {
    const byMessageSid = await resolveAccountByMessageSid(status.messageSid);

    if (callback.messageType === "manual_reply" && callback.accountId) {
      const account = await getAccountConfigByAccountId(callback.accountId);
      const byCallbackAccount = account
        ? { status: "resolved" as const, account }
        : {
            status: "unresolved" as const,
            reason: "manual_reply_account_not_registered",
            lookupValue: callback.accountId,
          };

      return resolveConsistentAccountEvidence([
        { label: "MessageSid", resolution: byMessageSid },
        { label: "accountId", resolution: byCallbackAccount },
      ]);
    }

    return byMessageSid;
  }, "SMS status");
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
    messageType: callback.messageType,
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
    const result = callback.messageType === "auto_text" && status.messageSid && status.smsStatus
      ? await updateLeadSmsStatusByMessageSid({
        accountId: account.accountId,
        twilioMessageSid: status.messageSid,
        smsStatus: status.smsStatus,
        smsError: status.error,
      })
      : { updated: false };

    // Reconciliation: if no lead carries this MessageSid (e.g. Twilio accepted the SMS
    // but the lead update failed, leaving the lead stuck on "pending"), recover the lead
    // through the messages table and converge it to Twilio's true delivery status.
    let reconciledLeadId: string | null = null;
    if (callback.messageType === "auto_text" && !result.updated && status.messageSid && status.smsStatus) {
      const leadId = await getOutboundMessageLeadIdBySid({
        accountId: account.accountId,
        twilioMessageSid: status.messageSid,
      });

      if (leadId) {
        await updateLeadSmsStatus({
          accountId: account.accountId,
          id: leadId,
          smsStatus: status.smsStatus,
          smsError: status.error,
          twilioMessageSid: status.messageSid,
        });
        reconciledLeadId = leadId;

        console.warn("Reconciled stale lead SMS status from Twilio status callback", {
          correlationId,
          leadId,
          messageSid: status.messageSid,
          smsStatus: status.smsStatus,
        });
      }
    }

    if (status.messageSid && status.smsStatus) {
      await updateMessageStatusBySid({
        accountId: account.accountId,
        twilioMessageSid: status.messageSid,
        status: status.smsStatus,
        error: status.error,
      });
    }

    if (
      callback.messageType === "auto_text" &&
      status.messageSid &&
      status.smsStatus
    ) {
      if (typeof recordSmsOnboardingEvidence === "function") {
        await recordSmsOnboardingEvidence({
          accountId: account.accountId,
          messageSid: status.messageSid,
          status: status.smsStatus,
          errorCode: providerErrorCode(status.error),
        });
      }
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
        leadUpdated: result.updated || Boolean(reconciledLeadId),
        reconciledLeadId,
        messageType: callback.messageType,
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
