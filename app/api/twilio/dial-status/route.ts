import {
  createMissedCallLeadIfNew,
  hasRecentMissedCallSms,
  isOptedOut,
  logWebhookEvent,
  updateLeadSmsStatus,
} from "@/lib/supabase";
import { env } from "@/lib/env";
import {
  formDataToRecord,
  missedCallSmsBody,
  twilioClient,
  twilioWebhookUrl,
  validateTwilioRequest,
} from "@/lib/twilio";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const requestUrl = twilioWebhookUrl(request);
  const isValid = validateTwilioRequest({
    url: requestUrl,
    params: payload,
    signature: request.headers.get("x-twilio-signature"),
  });

  if (!isValid) {
    await logWebhookEvent({
      source: "twilio_dial_status",
      payload,
      responseStatus: 403,
      responseBody: "Forbidden",
      error: "Invalid Twilio signature",
    });

    return new Response("Forbidden", { status: 403 });
  }

  const dialCallStatus = String(formData.get("DialCallStatus") || "");
  const callerPhone = String(formData.get("From") || "").trim();
  const callSid = String(formData.get("CallSid") || "").trim();
  const xml = emptyTwiml();

  try {
    switch (dialCallStatus) {
      case "no-answer":
      case "busy":
      case "failed":
      case "canceled": {
        if (!callerPhone || !callSid) {
          throw new Error("Missing caller phone or CallSid on missed call webhook.");
        }

        const leadResult = await createMissedCallLeadIfNew({
          callSid,
          phone: callerPhone,
          message: `Missed call. Dial status: ${dialCallStatus}.`,
        });

        if (leadResult.inserted) {
          const cooldownSince = new Date(
            Date.now() - env.missedCallSmsCooldownHours * 60 * 60 * 1000,
          );
          const alreadyTextedRecently = await hasRecentMissedCallSms(callerPhone, cooldownSince);

          if (leadResult.leadId && alreadyTextedRecently) {
            await updateLeadSmsStatus({
              id: leadResult.leadId,
              smsStatus: "skipped_recent",
            });
            break;
          }

          if (leadResult.leadId && (await isOptedOut(callerPhone))) {
            await updateLeadSmsStatus({
              id: leadResult.leadId,
              smsStatus: "skipped_opt_out",
            });
            break;
          }

          try {
            await twilioClient.messages.create({
              to: callerPhone,
              from: env.twilioPhoneNumber,
              body: missedCallSmsBody(),
            });

            if (leadResult.leadId) {
              await updateLeadSmsStatus({
                id: leadResult.leadId,
                smsStatus: "sent",
              });
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown SMS send error";

            if (leadResult.leadId) {
              await updateLeadSmsStatus({
                id: leadResult.leadId,
                smsStatus: "failed",
                smsError: message,
              });
            }

            console.error("Failed to send missed call SMS", error);
          }
        }

        break;
      }
      case "completed":
      case "answered":
        break;
      default:
        console.warn(`Unhandled DialCallStatus: ${dialCallStatus}`);
        break;
    }

    await logWebhookEvent({
      source: "twilio_dial_status",
      payload,
      responseStatus: 200,
      responseBody: xml,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown dial-status error";

    await logWebhookEvent({
      source: "twilio_dial_status",
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
    });

    console.error("Failed to handle Twilio dial status", error);
  }

  return twimlResponse(xml);
}
