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

type OwnerSmsStatus = "sent" | "failed" | "skipped_opt_out" | "repeat_call";

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
    "smsEnabled" | "ownerPhoneNumber" | "twilioPhoneNumber" | "businessName"
  >;
  callerPhone: string;
  smsStatus: OwnerSmsStatus;
  correlationId: string;
}) {
  const { account } = input;

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
    await twilioClient.messages.create({
      to: account.ownerPhoneNumber,
      from: account.twilioPhoneNumber,
      body: ownerSmsBody({
        businessName: account.businessName,
        callerPhone: input.callerPhone,
        smsStatus: input.smsStatus,
      }),
    });
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

    return { inserted: true, becameLive: leadResult.becameLive, smsStatus: "skipped_disabled" as const };
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

    return { inserted: true, becameLive: leadResult.becameLive, smsStatus: "failed" as const, smsError: detail };
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
    return { inserted: true, becameLive: leadResult.becameLive, smsStatus: "skipped_recent" as const };
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
    return { inserted: true, becameLive: leadResult.becameLive, smsStatus: "skipped_opt_out" as const };
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

      await notifyOwnerNewLeadBySms({
        account,
        callerPhone,
        smsStatus: "sent",
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
    await notifyOwnerNewLeadBySms({
      account,
      callerPhone,
      smsStatus: "sent",
      correlationId,
    });

    return { inserted: true, becameLive: leadResult.becameLive, smsStatus: "sent" as const, twilioMessageSid: message.sid };
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
    await notifyOwnerNewLeadBySms({
      account,
      callerPhone,
      smsStatus: "failed",
      correlationId,
    });
    return { inserted: true, becameLive: leadResult.becameLive, smsStatus: "failed" as const, smsError: message };
  }
}
