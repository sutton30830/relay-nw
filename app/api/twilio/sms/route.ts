import { env } from "@/lib/env";
import { logWebhookEvent, recordOptOut } from "@/lib/supabase";
import {
  formDataToRecord,
  summarizeTwilioRequest,
  twilioClient,
  twilioWebhookUrls,
  validateTwilioRequest,
} from "@/lib/twilio";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";

const OPT_OUT_WORDS = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

function normalizeBody(value: string) {
  return value.trim().toUpperCase();
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const candidateUrls = twilioWebhookUrls(request);
  const validation = validateTwilioRequest({
    urls: candidateUrls,
    params: payload,
    signature: request.headers.get("x-twilio-signature"),
  });
  const requestSummary = summarizeTwilioRequest(request, payload);

  console.info("Twilio inbound SMS webhook received", requestSummary);

  if (!validation.isValid) {
    await logWebhookEvent({
      source: "twilio_inbound_sms",
      payload,
      responseStatus: 403,
      responseBody: "Forbidden",
      error: `Invalid Twilio signature. Candidate URLs: ${candidateUrls.join(" | ")}`,
    });

    return new Response("Forbidden", { status: 403 });
  }

  const from = String(formData.get("From") || "").trim();
  const body = String(formData.get("Body") || "").trim();
  const xml = emptyTwiml();

  try {
    if (from && OPT_OUT_WORDS.has(normalizeBody(body))) {
      await recordOptOut(from);
    } else if (from && body) {
      await twilioClient.messages.create({
        to: env.ownerPhoneNumber,
        from: env.twilioPhoneNumber,
        body: `Reply from ${from}: "${body}"`,
      });
    }

    await logWebhookEvent({
      source: "twilio_inbound_sms",
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: validation.matchedUrl ? `Validated with URL: ${validation.matchedUrl}` : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown inbound SMS error";

    await logWebhookEvent({
      source: "twilio_inbound_sms",
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
    });

    console.error("Failed to handle inbound Twilio SMS", error);
  }

  return twimlResponse(xml);
}
