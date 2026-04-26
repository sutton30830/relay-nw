import twilio from "twilio";
import { env } from "@/lib/env";

const DEFAULT_MISSED_CALL_SMS_TEMPLATE =
  "Hi, this is {BUSINESS_NAME} - sorry we missed your call. Book or reply here: {INTAKE_URL}. Reply STOP to opt out.";

type TwilioRequestSummary = {
  method: string;
  path: string;
  callSid: string | null;
  messageSid: string | null;
  recordingSid: string | null;
  recordingStatus: string | null;
  from: string | null;
  to: string | null;
  dialCallStatus: string | null;
  callMode: typeof env.callMode;
  hasOwnerPhoneNumber: boolean;
  hasTwilioPhoneNumber: boolean;
};

export const twilioClient = twilio(env.twilioAccountSid, env.twilioAuthToken);

function replaceTemplateValues(template: string, values: Record<string, string>) {
  let output = template;

  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{${key}}`, value);
  }

  return output;
}

export function missedCallSmsBody() {
  return replaceTemplateValues(env.smsTemplate || DEFAULT_MISSED_CALL_SMS_TEMPLATE, {
    BUSINESS_NAME: env.businessName,
    INTAKE_URL: env.intakeUrl,
    SCHEDULING_URL: env.schedulingUrl,
  });
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
    try {
      if (twilio.validateRequest(env.twilioAuthToken, input.signature, url, input.params)) {
        return { isValid: true, matchedUrl: url };
      }
    } catch (error) {
      console.warn("Twilio signature validation threw an error", {
        url,
        error: error instanceof Error ? error.message : "Unknown validation error",
      });
    }
  }

  return { isValid: false, matchedUrl: null as string | null };
}

function requestPathAndSearch(requestUrl: string) {
  const url = new URL(requestUrl);
  return `${url.pathname}${url.search}`;
}

function forwardedOrigin(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");

  if (!forwardedProto || !forwardedHost) {
    return null;
  }

  return `${forwardedProto}://${forwardedHost}`;
}

export function twilioWebhookUrls(request: Request) {
  const pathAndSearch = requestPathAndSearch(request.url);
  const proxyOrigin = forwardedOrigin(request);

  const candidates = new Set<string>();
  candidates.add(request.url);
  candidates.add(`${env.appBaseUrl}${pathAndSearch}`);

  if (proxyOrigin) {
    candidates.add(`${proxyOrigin}${pathAndSearch}`);
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

export function summarizeTwilioRequest(
  request: Request,
  payload: Record<string, string>,
): TwilioRequestSummary {
  const url = new URL(request.url);

  return {
    method: request.method,
    path: url.pathname,
    callSid: payload.CallSid ?? null,
    messageSid: payload.MessageSid ?? payload.SmsSid ?? null,
    recordingSid: payload.RecordingSid ?? null,
    recordingStatus: payload.RecordingStatus ?? null,
    from: payload.From ?? null,
    to: payload.To ?? null,
    dialCallStatus: payload.DialCallStatus ?? null,
    callMode: env.callMode,
    hasOwnerPhoneNumber: Boolean(env.ownerPhoneNumber),
    hasTwilioPhoneNumber: Boolean(env.twilioPhoneNumber),
  };
}
