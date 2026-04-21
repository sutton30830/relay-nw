import { env } from "@/lib/env";
import { logWebhookEvent } from "@/lib/supabase";
import { formDataToRecord, twilioWebhookUrl, validateTwilioRequest } from "@/lib/twilio";
import { dialForwardTwiml, twimlResponse } from "@/lib/twiml";

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
      source: "twilio_voice",
      payload,
      responseStatus: 403,
      responseBody: "Forbidden",
      error: "Invalid Twilio signature",
    });

    return new Response("Forbidden", { status: 403 });
  }

  const callerPhone = String(formData.get("From") || env.twilioPhoneNumber);
  const actionUrl = `${env.appBaseUrl}/api/twilio/dial-status`;

  const xml = dialForwardTwiml({
    ownerPhoneNumber: env.ownerPhoneNumber,
    callerId: callerPhone,
    actionUrl,
    timeoutSeconds: env.dialTimeoutSeconds,
  });

  await logWebhookEvent({
    source: "twilio_voice",
    payload,
    responseStatus: 200,
    responseBody: xml,
  });

  return twimlResponse(xml);
}
