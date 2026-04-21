import twilio from "twilio";
import { env } from "@/lib/env";

export const twilioClient = twilio(env.twilioAccountSid, env.twilioAuthToken);

export function missedCallSmsBody() {
  const defaultTemplate =
    "Hi, this is {BUSINESS_NAME} - sorry we missed your call. Book or reply here: {INTAKE_URL}. Reply STOP to opt out.";

  return (env.smsTemplate || defaultTemplate)
    .replaceAll("{BUSINESS_NAME}", env.businessName)
    .replaceAll("{INTAKE_URL}", env.intakeUrl)
    .replaceAll("{SCHEDULING_URL}", env.schedulingUrl);
}

export function validateTwilioRequest(input: {
  url: string;
  params: Record<string, string>;
  signature: string | null;
}) {
  if (!input.signature) {
    return false;
  }

  return twilio.validateRequest(
    env.twilioAuthToken,
    input.signature,
    input.url,
    input.params,
  );
}

export function twilioWebhookUrl(request: Request) {
  const url = new URL(request.url);
  return `${env.appBaseUrl}${url.pathname}${url.search}`;
}

export function formDataToRecord(formData: FormData) {
  const values: Record<string, string> = {};

  for (const [key, value] of formData.entries()) {
    values[key] = String(value);
  }

  return values;
}
