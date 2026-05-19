import { env } from "@/lib/env";
import { normalizePhoneNumber } from "@/lib/phone";
import {
  createMessageIfNew,
  createMissedCallLeadIfNew,
  hasRecentMissedCallSms,
  isOptedOut,
  type AccountRuntimeConfig,
  updateCallForMissedLead,
  updateLeadSmsStatus,
} from "@/lib/supabase";
import { envAccountConfig } from "@/lib/supabase/accounts";
import { missedCallSmsBodyForAccount, phoneLast4, twilioClient } from "@/lib/twilio";

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
  const account = input.account ?? envAccountConfig();

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

  await updateCallForMissedLead({
    accountId: account.accountId,
    callSid,
    leadId: leadResult.leadId,
    status: "missed",
  });

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

    return { inserted: true, smsStatus: "skipped_disabled" as const };
  }

  const cooldownSince = new Date(
    Date.now() - account.missedCallSmsCooldownHours * 60 * 60 * 1000,
  );
  const alreadyTextedRecently = await hasRecentMissedCallSms(
    callerPhone,
    cooldownSince,
    leadResult.leadId,
    account.accountId,
  );

  if (alreadyTextedRecently) {
    await updateLeadSmsStatus({
      accountId: account.accountId,
      id: leadResult.leadId,
      smsStatus: "skipped_recent",
    });
    return { inserted: true, smsStatus: "skipped_recent" as const };
  }

  if (await isOptedOut(callerPhone, account.accountId)) {
    await updateLeadSmsStatus({
      accountId: account.accountId,
      id: leadResult.leadId,
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

      return {
        inserted: true,
        smsStatus: "sent_update_failed" as const,
        twilioMessageSid: message.sid,
      };
    }

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
    return { inserted: true, smsStatus: "failed" as const, smsError: message };
  }
}
