import { env } from "@/lib/env";
import { normalizePhoneNumber } from "@/lib/phone";
import {
  createMessageIfNew,
  createMissedCallLeadIfNew,
  hasRecentMissedCallSms,
  isOptedOut,
  recordProviderAction,
  assertTenantAccount,
  type AccountRuntimeConfig,
  updateCallForMissedLead,
  updateLeadSmsStatus,
} from "@/lib/supabase";
import { envAccountConfig } from "@/lib/supabase/accounts";
import { missedCallSmsBodyForAccount, phoneLast4, sendOwnerSms, twilioClient } from "@/lib/twilio";
import { notifyAdminOperationalIssue, notifyOwnerNewMissedCallLead } from "@/lib/email";

type OwnerSmsStatus = "sent" | "failed" | "skipped_opt_out" | "repeat_call";

async function notifyOwnerNewLeadByPush(input: {
  account: Pick<AccountRuntimeConfig, "accountId" | "businessName">;
  leadId: string;
  callerPhone: string;
}) {
  try {
    const { notifyOwnerByWebPush } = await import("@/lib/web-push");
    return await notifyOwnerByWebPush({
      account: input.account,
      event: "missed_call",
      leadId: input.leadId,
      callerPhone: input.callerPhone,
    });
  } catch (error) {
    console.error("Owner Web Push notification could not start", {
      accountId: input.account.accountId,
      leadId: input.leadId,
      error: error instanceof Error ? error.message : error,
    });
    return { attempted: 0, delivered: 0, disabled: 0 };
  }
}

function ownerSmsBody(input: {
  businessName: string;
  callerPhone: string;
  smsStatus: OwnerSmsStatus;
}) {
  const inboxUrl = `${env.appBaseUrl}/leads`;

  if (input.smsStatus === "sent") {
    return `Relay NW: missed call for ${input.businessName} from ${input.callerPhone}. We texted them back. Reply from your inbox: ${inboxUrl}`;
  }

  if (input.smsStatus === "skipped_opt_out") {
    return `Relay NW: missed call for ${input.businessName} from ${input.callerPhone}. They opted out of texting, so call them back. Inbox: ${inboxUrl}`;
  }

  if (input.smsStatus === "repeat_call") {
    return `Relay NW: ${input.callerPhone} called ${input.businessName} again and was missed. They were already texted, so no new auto-text went out. Consider calling back. Inbox: ${inboxUrl}`;
  }

  return `Relay NW: missed call for ${input.businessName} from ${input.callerPhone}. The auto-text FAILED. Call them back now. Inbox: ${inboxUrl}`;
}

// Texts the owner about a new missed-call lead. Email can sit unread for hours; owners
// live in their messages app. Never throws: a notification failure must not disturb the
// customer-facing flow, and the owner still gets the email fallback.
async function notifyOwnerNewLeadBySms(input: {
  account: Pick<
    AccountRuntimeConfig,
    "accountId" | "smsEnabled" | "ownerPhoneNumber" | "twilioPhoneNumber" | "businessName" | "notificationPreferences"
  >;
  callerPhone: string;
  smsStatus: OwnerSmsStatus;
  correlationId: string;
}) {
  const { account } = input;

  if (account.notificationPreferences?.missedCall.sms === false) {
    console.info("Owner missed-call SMS suppressed by account preference", {
      accountId: account.accountId,
      correlationId: input.correlationId,
    });
    return;
  }

  // Owner SMS rides the same A2P-gated number as customer texting. If customer texting
  // is disabled (campaign not approved yet), do not send owner texts from it either.
  if (!account.smsEnabled || !account.ownerPhoneNumber || !account.twilioPhoneNumber) {
    return;
  }

  // Don't text the owner about their own call (e.g. the owner testing their line).
  if (normalizePhoneNumber(input.callerPhone) === account.ownerPhoneNumber) {
    return;
  }

  try {
    const body = ownerSmsBody({
      businessName: account.businessName,
      callerPhone: input.callerPhone,
      smsStatus: input.smsStatus,
    });
    if (typeof sendOwnerSms === "function") {
      await sendOwnerSms({
        account,
        context: "missed-call owner notification",
        actionKey: `owner_sms:missed_call:${input.correlationId}`,
        body,
      });
    } else {
      // Compatibility for isolated test harnesses; production always uses the
      // idempotent, evidence-recording sendOwnerSms path above.
      await twilioClient.messages.create({
        to: account.ownerPhoneNumber,
        from: account.twilioPhoneNumber,
        body,
      });
    }
  } catch (error) {
    console.error("Owner SMS notification failed (email fallback still sent)", {
      correlationId: input.correlationId,
      ownerLast4: phoneLast4(account.ownerPhoneNumber),
      smsStatus: input.smsStatus,
      error: error instanceof Error ? error.message : error,
    });
  }
}

export async function handleMissedCall(input: {
  account?: AccountRuntimeConfig;
  callerPhone: string;
  callSid: string;
  message: string | null;
  correlationId?: string | null;
  twilioSignatureValid?: boolean;
}) {
  const callerPhone = normalizePhoneNumber(input.callerPhone);
  const callSid = input.callSid.trim();
  const correlationId = input.correlationId ?? callSid;
  const account = assertTenantAccount(input.account ?? envAccountConfig(), "handleMissedCall");

  if (!callerPhone || !callSid) {
    throw new Error("Missing caller phone or CallSid on missed call webhook.");
  }

  const leadResult = await createMissedCallLeadIfNew({
    accountId: account.accountId,
    callSid,
    phone: callerPhone,
    message: input.message,
    twilioSignatureValid: input.twilioSignatureValid === true,
  });

  if (!leadResult.inserted || !leadResult.leadId) {
    return { inserted: false, becameLive: false, smsStatus: "duplicate" as const };
  }

  const providerActionKey = `automatic_missed_call_sms:${leadResult.leadId}`;
  // Start the A2P-independent owner alert immediately, but let the compliance-
  // sensitive customer SMS proceed in parallel. Every terminal path below waits
  // for this promise so the serverless invocation cannot freeze it mid-send.
  const ownerPushPromise = notifyOwnerNewLeadByPush({
    account,
    leadId: leadResult.leadId,
    callerPhone,
  });
  async function finish<T>(result: T) {
    await ownerPushPromise;
    return result;
  }
  const recordSmsAction = async (input: Parameters<typeof recordProviderAction>[0]) => {
    if (typeof recordProviderAction !== "function") return null;
    return recordProviderAction(input);
  };

  try {
    await updateCallForMissedLead({
      accountId: account.accountId,
      callSid,
      leadId: leadResult.leadId,
      status: "missed",
    });
  } catch (error) {
    // Call-row bookkeeping must not block the customer-facing SMS.
    console.error("Could not link call row to missed-call lead", {
      correlationId,
      callSid,
      leadId: leadResult.leadId,
      error: error instanceof Error ? error.message : error,
    });
  }

  if (!account.smsEnabled) {
    try {
      await updateLeadSmsStatus({
        accountId: account.accountId,
        id: leadResult.leadId,
        smsStatus: "skipped_disabled",
      });
    } catch (error) {
      console.warn("Could not mark SMS as disabled. Run supabase.sql to allow skipped_disabled.", {
        correlationId,
        callSid,
        callerLast4: phoneLast4(callerPhone),
        leadId: leadResult.leadId,
        error,
      });
    }

    console.info("Missed-call SMS suppressed because SMS_ENABLED is false", {
      correlationId,
      callSid,
      callerLast4: phoneLast4(callerPhone),
      leadId: leadResult.leadId,
    });

    await notifyOwnerNewMissedCallLead({
      account,
      leadId: leadResult.leadId,
      callerPhone,
      smsStatus: "skipped_disabled",
    });

    await recordSmsAction({
      accountId: account.accountId,
      action: "automatic_missed_call_sms",
      provider: "twilio",
      idempotencyKey: providerActionKey,
      resourceType: "lead",
      resourceId: leadResult.leadId,
      internalStatus: "suppressed",
      providerStatus: "sms_disabled",
      customerExplanation: "Automatic texting is not enabled for this account.",
      retryEligibility: "never",
      recommendedNextAction: "Enable texting only after A2P approval, then contact this caller manually.",
      customerVisible: false,
      expectedSuppression: true,
    });

    return finish({ inserted: true, becameLive: leadResult.becameLive, smsStatus: "skipped_disabled" as const });
  }

  // Fail closed: if the cooldown or opt-out check cannot be completed, do not send
  // (compliance-safe) and mark the lead "failed" so it is never left ambiguously "pending".
  let alreadyTextedRecently: boolean;
  let optedOut: boolean;
  try {
    const cooldownSince = new Date(
      Date.now() - account.missedCallSmsCooldownHours * 60 * 60 * 1000,
    );
    alreadyTextedRecently = await hasRecentMissedCallSms(
      callerPhone,
      cooldownSince,
      account.accountId,
      leadResult.leadId,
      leadResult.createdAt ?? null,
    );
    optedOut = !alreadyTextedRecently && (await isOptedOut(callerPhone, account.accountId));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown pre-send check error";
    const detail = `Could not verify SMS cooldown/opt-out, SMS not sent: ${message}`;

    console.error("Missed-call SMS pre-send checks failed; failing closed", {
      correlationId,
      callSid,
      callerLast4: phoneLast4(callerPhone),
      leadId: leadResult.leadId,
      error: message,
    });

    try {
      await updateLeadSmsStatus({
        accountId: account.accountId,
        id: leadResult.leadId,
        smsStatus: "failed",
        smsError: detail,
      });
    } catch (updateError) {
      console.error("Could not mark lead failed after pre-send check failure", {
        correlationId,
        leadId: leadResult.leadId,
        error: updateError instanceof Error ? updateError.message : updateError,
      });
    }

    await notifyAdminOperationalIssue({
      account,
      issue: "Missed-call SMS pre-send checks failed (SMS not sent)",
      detail,
      correlationId,
    });

    await recordSmsAction({
      accountId: account.accountId,
      action: "automatic_missed_call_sms",
      provider: "supabase",
      idempotencyKey: providerActionKey,
      resourceType: "lead",
      resourceId: leadResult.leadId,
      internalStatus: "failed",
      providerStatus: "pre_send_check_failed",
      diagnosticDetail: message,
      customerExplanation: "Relay could not safely verify texting consent, so no message was sent.",
      retryEligibility: "manual",
      recommendedNextAction: "Verify opt-out and cooldown records, then call the customer or retry once from Operations.",
      customerVisible: true,
      countAttempt: true,
    });

    return finish({ inserted: true, becameLive: leadResult.becameLive, smsStatus: "failed" as const, smsError: detail });
  }

  if (alreadyTextedRecently) {
    await updateLeadSmsStatus({
      accountId: account.accountId,
      id: leadResult.leadId,
      smsStatus: "skipped_recent",
    });
    // A repeat missed call inside the cooldown window used to be invisible to the
    // owner. It is often the opposite of ignorable: the caller is trying again.
    await notifyOwnerNewLeadBySms({
      account,
      callerPhone,
      smsStatus: "repeat_call",
      correlationId,
    });
    await recordSmsAction({
      accountId: account.accountId,
      action: "automatic_missed_call_sms",
      provider: "relay",
      idempotencyKey: providerActionKey,
      resourceType: "lead",
      resourceId: leadResult.leadId,
      internalStatus: "suppressed",
      providerStatus: "cooldown",
      customerExplanation: "Relay did not send a duplicate automatic text during the cooldown window.",
      retryEligibility: "never",
      recommendedNextAction: "Call the repeat caller from the inbox.",
      customerVisible: false,
      expectedSuppression: true,
    });
    return finish({ inserted: true, becameLive: leadResult.becameLive, smsStatus: "skipped_recent" as const });
  }

  if (optedOut) {
    await updateLeadSmsStatus({
      accountId: account.accountId,
      id: leadResult.leadId,
      smsStatus: "skipped_opt_out",
    });
    await notifyOwnerNewMissedCallLead({
      account,
      leadId: leadResult.leadId,
      callerPhone,
      smsStatus: "skipped_opt_out",
    });
    await notifyOwnerNewLeadBySms({
      account,
      callerPhone,
      smsStatus: "skipped_opt_out",
      correlationId,
    });
    await recordSmsAction({
      accountId: account.accountId,
      action: "automatic_missed_call_sms",
      provider: "relay",
      idempotencyKey: providerActionKey,
      resourceType: "lead",
      resourceId: leadResult.leadId,
      internalStatus: "suppressed",
      providerStatus: "opted_out",
      customerExplanation: "The caller opted out of text messages, so Relay did not send one.",
      retryEligibility: "never",
      recommendedNextAction: "Call the customer instead.",
      customerVisible: false,
      expectedSuppression: true,
    });
    return finish({ inserted: true, becameLive: leadResult.becameLive, smsStatus: "skipped_opt_out" as const });
  }

  try {
    await recordSmsAction({
      accountId: account.accountId,
      action: "automatic_missed_call_sms",
      provider: "twilio",
      idempotencyKey: providerActionKey,
      resourceType: "lead",
      resourceId: leadResult.leadId,
      internalStatus: "processing",
      providerStatus: "requesting",
      customerExplanation: "Relay is sending the automatic missed-call text.",
      retryEligibility: "manual",
      recommendedNextAction: "Wait for Twilio's signed delivery callback.",
      customerVisible: false,
      countAttempt: true,
    });
    const statusCallback = new URL("/api/twilio/sms-status", env.appBaseUrl);
    statusCallback.searchParams.set("messageType", "auto_text");
    statusCallback.searchParams.set("accountId", account.accountId);
    statusCallback.searchParams.set("leadId", leadResult.leadId);
    statusCallback.searchParams.set("actionKey", providerActionKey);
    const message = await twilioClient.messages.create({
      to: callerPhone,
      from: account.twilioPhoneNumber,
      body: missedCallSmsBodyForAccount(account),
      statusCallback: statusCallback.toString(),
    });

    try {
      await recordSmsAction({
        accountId: account.accountId,
        action: "automatic_missed_call_sms",
        provider: "twilio",
        idempotencyKey: providerActionKey,
        providerIdentifier: message.sid,
        resourceType: "lead",
        resourceId: leadResult.leadId,
        internalStatus: "accepted",
        providerStatus: message.status || "accepted",
        customerExplanation: "Twilio accepted the automatic text. Delivery confirmation is pending.",
        retryEligibility: "never",
        recommendedNextAction: "Wait for the signed delivery callback; do not resend automatically.",
        customerVisible: false,
      });
    } catch (actionError) {
      console.error("Twilio accepted SMS, but Relay could not update provider action evidence", {
        correlationId,
        leadId: leadResult.leadId,
        twilioMessageSid: message.sid,
        error: actionError instanceof Error ? actionError.message : actionError,
      });
    }

    // Twilio has already accepted the SMS past this point. A failure recording it in the
    // messages table must NOT bubble into the outer catch, which would wrongly mark the
    // lead "failed" (and re-open the cooldown, risking a double text on a repeat call).
    let messageRowRecorded = true;
    try {
      await createMessageIfNew({
        accountId: account.accountId,
        leadId: leadResult.leadId,
        twilioMessageSid: message.sid,
        direction: "outbound",
        fromPhone: account.twilioPhoneNumber,
        toPhone: callerPhone,
        body: missedCallSmsBodyForAccount(account),
        status: "sent",
      });
    } catch (error) {
      messageRowRecorded = false;
      const detail = error instanceof Error ? error.message : "Unknown message insert error";

      console.error("Twilio accepted SMS, but Relay could not record the message row", {
        correlationId,
        leadId: leadResult.leadId,
        twilioMessageSid: message.sid,
        error: detail,
      });

      await notifyAdminOperationalIssue({
        account,
        issue: "Twilio accepted SMS but message row insert failed",
        detail: `${detail} (MessageSid ${message.sid})`,
        correlationId,
      });
    }

    try {
      await updateLeadSmsStatus({
        accountId: account.accountId,
        id: leadResult.leadId,
        smsStatus: "sent",
        twilioMessageSid: message.sid,
      });
    } catch (error) {
      const updateErrorMessage = error instanceof Error ? error.message : "Unknown SMS update error";

      console.error("Twilio accepted SMS, but Relay could not update the lead", {
        correlationId,
        leadId: leadResult.leadId,
        twilioMessageSid: message.sid,
        error: updateErrorMessage,
      });

      await notifyAdminOperationalIssue({
        account,
        issue: "Twilio accepted SMS but lead update failed",
        detail: messageRowRecorded
          ? `${updateErrorMessage} — the lead will self-heal when the next Twilio status callback arrives (reconciled via the messages table).`
          : `${updateErrorMessage} — the message row also failed to record, so automatic reconciliation is not possible; check MessageSid ${message.sid} in Twilio.`,
        correlationId,
      });

      await notifyOwnerNewLeadBySms({
        account,
        callerPhone,
        smsStatus: "sent",
        correlationId,
      });

      return finish({
        inserted: true,
        becameLive: leadResult.becameLive,
        smsStatus: "sent_update_failed" as const,
        twilioMessageSid: message.sid,
      });
    }

    await notifyOwnerNewMissedCallLead({
      account,
      leadId: leadResult.leadId,
      callerPhone,
      smsStatus: "sent",
    });
    await notifyOwnerNewLeadBySms({
      account,
      callerPhone,
      smsStatus: "sent",
      correlationId,
    });

    return finish({ inserted: true, becameLive: leadResult.becameLive, smsStatus: "sent" as const, twilioMessageSid: message.sid });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SMS send error";

    try {
      await recordSmsAction({
        accountId: account.accountId,
        action: "automatic_missed_call_sms",
        provider: "twilio",
        idempotencyKey: providerActionKey,
        resourceType: "lead",
        resourceId: leadResult.leadId,
        internalStatus: "failed",
        providerStatus: "send_failed",
        diagnosticDetail: message,
        customerVisible: true,
      });
    } catch (actionError) {
      console.error("Could not record automatic SMS provider failure", {
        correlationId,
        leadId: leadResult.leadId,
        error: actionError instanceof Error ? actionError.message : actionError,
      });
    }

    await updateLeadSmsStatus({
      accountId: account.accountId,
      id: leadResult.leadId,
      smsStatus: "failed",
      smsError: message,
    });

    console.error("Failed to send missed call SMS", {
      correlationId,
      callSid,
      callerLast4: phoneLast4(callerPhone),
      leadId: leadResult.leadId,
      error: message,
    });
    await notifyAdminOperationalIssue({
      account,
      issue: "Missed-call SMS send failed",
      detail: message,
      correlationId,
    });
    await notifyOwnerNewMissedCallLead({
      account,
      leadId: leadResult.leadId,
      callerPhone,
      smsStatus: "failed",
    });
    await notifyOwnerNewLeadBySms({
      account,
      callerPhone,
      smsStatus: "failed",
      correlationId,
    });
    return finish({ inserted: true, becameLive: leadResult.becameLive, smsStatus: "failed" as const, smsError: message });
  }
}
