import { env } from "@/lib/env";
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
  const callerPhone = input.callerPhone.trim();
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
    await twilioClient.messages.create({
      to: callerPhone,
      from: env.twilioPhoneNumber,
      body: missedCallSmsBody(),
    });

    await updateLeadSmsStatus({
      id: leadResult.leadId,
      smsStatus: "sent",
    });

    return { inserted: true, smsStatus: "sent" as const };
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
