import { env } from "@/lib/env";
import { normalizePhoneNumber } from "@/lib/phone";
import {
  createMissedCallLeadIfNew,
  hasRecentMissedCallSms,
  isOptedOut,
  updateLeadSmsStatus,
} from "@/lib/supabase";
import { missedCallSmsBody, twilioClient } from "@/lib/twilio";

export async function handleMissedCall(input: {
  callerPhone: string;
  callSid: string;
  message: string;
}) {
  const callerPhone = normalizePhoneNumber(input.callerPhone);
  const callSid = input.callSid.trim();

  if (!callerPhone || !callSid) {
    throw new Error("Missing caller phone or CallSid on missed call webhook.");
  }

  const leadResult = await createMissedCallLeadIfNew({
    callSid,
    phone: callerPhone,
    message: input.message,
  });

  if (!leadResult.inserted || !leadResult.leadId) {
    return { inserted: false, smsStatus: "duplicate" as const };
  }

  const cooldownSince = new Date(
    Date.now() - env.missedCallSmsCooldownHours * 60 * 60 * 1000,
  );
  const alreadyTextedRecently = await hasRecentMissedCallSms(callerPhone, cooldownSince);

  if (alreadyTextedRecently) {
    await updateLeadSmsStatus({
      id: leadResult.leadId,
      smsStatus: "skipped_recent",
    });
    return { inserted: true, smsStatus: "skipped_recent" as const };
  }

  if (await isOptedOut(callerPhone)) {
    await updateLeadSmsStatus({
      id: leadResult.leadId,
      smsStatus: "skipped_opt_out",
    });
    return { inserted: true, smsStatus: "skipped_opt_out" as const };
  }

  try {
    const message = await twilioClient.messages.create({
      to: callerPhone,
      from: env.twilioPhoneNumber,
      body: missedCallSmsBody(),
      statusCallback: `${env.appBaseUrl}/api/twilio/sms-status`,
    });

    try {
      await updateLeadSmsStatus({
        id: leadResult.leadId,
        smsStatus: "sent",
        twilioMessageSid: message.sid,
      });
    } catch (error) {
      console.error("Twilio accepted SMS, but Relay could not update the lead", {
        leadId: leadResult.leadId,
        twilioMessageSid: message.sid,
        error,
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
      id: leadResult.leadId,
      smsStatus: "failed",
      smsError: message,
    });

    console.error("Failed to send missed call SMS", error);
    return { inserted: true, smsStatus: "failed" as const, smsError: message };
  }
}
