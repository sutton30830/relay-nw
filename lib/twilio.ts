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
  urls: string[];
  params: Record<string, string>;
  signature: string | null;
}) {
  if (!input.signature) {
    return { isValid: false, matchedUrl: null as string | null };
  }

  for (const url of input.urls) {
    if (twilio.validateRequest(env.twilioAuthToken, input.signature, url, input.params)) {
      return { isValid: true, matchedUrl: url };
    }
  }

  return { isValid: false, matchedUrl: null as string | null };
}

export function twilioWebhookUrls(request: Request) {
  const url = new URL(request.url);
  const pathnameAndSearch = `${url.pathname}${url.search}`;
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");

  const candidates = new Set<string>();
  candidates.add(request.url);
  candidates.add(`${env.appBaseUrl}${pathnameAndSearch}`);

  if (forwardedProto && forwardedHost) {
    candidates.add(`${forwardedProto}://${forwardedHost}${pathnameAndSearch}`);
  }

  return Array.from(candidates);
}

export function formDataToRecord(formData: FormData) {
  const values: Record<string, string> = {};

  for (const [key, value] of formData.entries()) {
    values[key] = String(value);
  }

  return values;
}

export function summarizeTwilioRequest(request: Request, payload: Record<string, string>) {
  return {
    method: request.method,
    path: new URL(request.url).pathname,
    callSid: payload.CallSid ?? null,
    from: payload.From ?? null,
    to: payload.To ?? null,
    dialCallStatus: payload.DialCallStatus ?? null,
    callMode: env.callMode,
    hasOwnerPhoneNumber: Boolean(env.ownerPhoneNumber),
    hasTwilioPhoneNumber: Boolean(env.twilioPhoneNumber),
  };
}
