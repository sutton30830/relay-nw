import { env } from "@/lib/env";
import { normalizePhoneNumber } from "@/lib/phone";
import {
  createMessageIfNew,
  createMissedCallLeadIfNew,
  hasRecentMissedCallSms,
  isOptedOut,
  assertTenantAccount,
  type AccountRuntimeConfig,
  updateCallForMissedLead,
  updateLeadSmsStatus,
} from "@/lib/supabase";
import { envAccountConfig } from "@/lib/supabase/accounts";
import { missedCallSmsBodyForAccount, phoneLast4, twilioClient } from "@/lib/twilio";
import { notifyAdminOperationalIssue, notifyOwnerNewMissedCallLead } from "@/lib/email";

export async function handleMissedCall(input: {
  account?: AccountRuntimeConfig;
  callerPhone: string;
  callSid: string;
  message: string | null;
  correlationId?: string | null;
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
  });

  if (!leadResult.inserted || !leadResult.leadId) {
    return { inserted: false, smsStatus: "duplicate" as const };
  }

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

    return { inserted: true, smsStatus: "skipped_disabled" as const };
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

    return { inserted: true, smsStatus: "failed" as const, smsError: detail };
  }

  if (alreadyTextedRecently) {
    await updateLeadSmsStatus({
      accountId: account.accountId,
      id: leadResult.leadId,
      smsStatus: "skipped_recent",
    });
    return { inserted: true, smsStatus: "skipped_recent" as const };
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
    return { inserted: true, smsStatus: "skipped_opt_out" as const };
  }

  try {
    const message = await twilioClient.messages.create({
      to: callerPhone,
      from: account.twilioPhoneNumber,
      body: missedCallSmsBodyForAccount(account),
      statusCallback: `${env.appBaseUrl}/api/twilio/sms-status`,
    });

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

      return {
        inserted: true,
        smsStatus: "sent_update_failed" as const,
        twilioMessageSid: message.sid,
      };
    }

    await notifyOwnerNewMissedCallLead({
      account,
      leadId: leadResult.leadId,
      callerPhone,
      smsStatus: "sent",
    });

    return { inserted: true, smsStatus: "sent" as const, twilioMessageSid: message.sid };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SMS send error";

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
    return { inserted: true, smsStatus: "failed" as const, smsError: message };
  }
}
