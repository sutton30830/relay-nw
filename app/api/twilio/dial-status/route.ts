import { createLead } from "@/lib/supabase";
import { env } from "@/lib/env";
import { missedCallSmsBody, twilioClient } from "@/lib/twilio";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

const MISSED_STATUSES = new Set(["no-answer", "busy", "failed", "canceled"]);

export async function POST(request: Request) {
  const formData = await request.formData();
  const dialCallStatus = String(formData.get("DialCallStatus") || "");
  const callerPhone = String(formData.get("From") || "").trim();

  if (MISSED_STATUSES.has(dialCallStatus) && callerPhone) {
    try {
      await twilioClient.messages.create({
        to: callerPhone,
        from: env.twilioPhoneNumber,
        body: missedCallSmsBody(),
      });
    } catch (error) {
      console.error("Failed to send missed call SMS", error);
    }

    try {
      await createLead({
        phone: callerPhone,
        message: `Missed call. Dial status: ${dialCallStatus}.`,
        source: "missed_call",
      });
    } catch (error) {
      console.error("Failed to save missed call lead", error);
    }
  }

  return twimlResponse(emptyTwiml());
}
