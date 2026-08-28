import twilio from "twilio";
import { env } from "@/lib/env";
import { notifyAdminOperationalIssue } from "@/lib/email";
import { logWebhookEvent, type WebhookEventSource } from "@/lib/supabase";
import type { AccountRuntimeConfig } from "@/lib/supabase/accounts";
import { twilioWebhookUrlCandidates } from "@/lib/twilio-webhook-urls";
import { getTelephonyProvider } from "@/lib/telephony/registry";
import { phoneLast4 } from "@/lib/phone";
import {
  fetchTwilioA2pRegistrationEvidence,
} from "@/lib/telephony/providers/twilio";
export { sendOwnerSms } from "@/lib/telephony/owner-sms";
export { phoneLast4 };
export { twilioClient } from "@/lib/telephony/providers/twilio";

const DEFAULT_MISSED_CALL_SMS_TEMPLATE =
  "Hi, this is {BUSINESS_NAME} - sorry we missed your call. Book or reply here: {INTAKE_URL}. Reply STOP to opt out.";

type TwilioRequestSummary = {
  method: string;
  path: string;
  callSid: string | null;
  messageSid: string | null;
  recordingSid: string | null;
  recordingStatus: string | null;
  fromLast4: string | null;
  toLast4: string | null;
  dialCallStatus: string | null;
  callMode: typeof env.callMode;
  hasOwnerPhoneNumber: boolean;
  hasTwilioPhoneNumber: boolean;
};

export async function fetchA2pRegistrationEvidence(
  messagingServiceSid: string,
  campaignSid: string,
  relayPhoneNumber: string,
) {
  return fetchTwilioA2pRegistrationEvidence(
    messagingServiceSid,
    campaignSid,
    relayPhoneNumber,
  );
}

export async function findAvailableRelayNumbers(areaCode: string, limit = 8) {
  const numbers = await getTelephonyProvider().findNumbers({
    countryCode: "US",
    areaCode,
    limit,
    requiredCapabilities: { voice: true, sms: true },
  });
  return numbers.map((number) => ({ phoneNumber: number.phoneNumber, locality: number.locality, region: number.region }));
}

export async function configureExistingRelayNumber(phoneNumber: string) {
  const base = env.appBaseUrl;
  const configured = await getTelephonyProvider().configureNumber({
    phoneNumber,
    webhooks: {
      voice: {
        url: `${base}/api/twilio/voice`,
        fallbackUrl: `${base}/api/twilio/voice`,
      },
      messaging: { url: `${base}/api/twilio/sms` },
    },
  });
  return { sid: configured.numberId.value, phoneNumber: configured.phoneNumber };
}

function replaceTemplateValues(template: string, values: Record<string, string>) {
  let output = template;

  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{${key}}`, value);
  }

  return output;
}

export function missedCallSmsBody() {
  return missedCallSmsBodyForAccount({
    businessName: env.businessName,
    intakeUrl: env.intakeUrl,
    schedulingUrl: env.schedulingUrl,
    smsTemplate: env.smsTemplate ?? null,
  });
}

export function missedCallSmsBodyForAccount(config: Pick<
  AccountRuntimeConfig,
  "businessName" | "intakeUrl" | "schedulingUrl" | "smsTemplate"
>) {
  return replaceTemplateValues(config.smsTemplate || DEFAULT_MISSED_CALL_SMS_TEMPLATE, {
    BUSINESS_NAME: config.businessName,
    INTAKE_URL: config.intakeUrl,
    SCHEDULING_URL: config.schedulingUrl,
  });
}

export function isTrustedTwilioMediaUrl(value: string | null | undefined): boolean {
  if (!value) return false;

  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "api.twilio.com";
  } catch {
    return false;
  }
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

export function validateTwilioWebhook(request: Request, payload: Record<string, string>) {
  const candidateUrls = twilioWebhookUrls(request);
  const signature = request.headers.get("x-twilio-signature");
  const validation = validateTwilioRequest({
    urls: candidateUrls,
    params: payload,
    signature,
  });

  return {
    ...validation,
    candidateUrls,
    hasSignature: Boolean(signature),
    shouldReject: !validation.isValid && !env.allowUnsignedTwilioWebhooks,
    wasAllowedByOverride: !validation.isValid && env.allowUnsignedTwilioWebhooks,
  };
}

export async function rejectInvalidTwilioSignature(input: {
  accountId?: string | null;
  source: WebhookEventSource;
  label: string;
  payload: Record<string, string>;
  correlationId?: string | null;
  requestSummary: TwilioRequestSummary;
  candidateUrls: string[];
  hasSignature: boolean;
  responseBody?: string;
}) {
  console.warn(`Twilio ${input.label} signature validation failed`, {
    correlationId: input.correlationId,
    ...input.requestSummary,
    candidateUrls: input.candidateUrls,
    hasSignature: input.hasSignature,
  });

  const responseBody = input.responseBody ?? "Forbidden";

  await logWebhookEvent({
    accountId: input.accountId,
    source: input.source,
    correlationId: input.correlationId,
    payload: input.payload,
    responseStatus: 403,
    responseBody,
    error: `Invalid Twilio signature. Candidate URLs: ${input.candidateUrls.join(" | ")}`,
  });

  if (process.env.NODE_ENV === "production") {
    await notifyAdminOperationalIssue({
      account: null,
      issue: `Invalid Twilio ${input.label} webhook rejected`,
      detail: `Candidate URLs: ${input.candidateUrls.join(" | ")}`,
      correlationId: input.correlationId,
    });
  }

  return new Response("Forbidden", { status: 403 });
}

export async function logUnsignedTwilioWebhook(input: {
  accountId?: string | null;
  source: WebhookEventSource;
  label: string;
  payload: Record<string, string>;
  correlationId?: string | null;
  requestSummary: TwilioRequestSummary;
  candidateUrls: string[];
  hasSignature: boolean;
  responseBody?: string;
}) {
  console.warn(`Unsigned Twilio ${input.label} webhook allowed by env override`, {
    correlationId: input.correlationId,
    ...input.requestSummary,
    candidateUrls: input.candidateUrls,
    hasSignature: input.hasSignature,
  });

  await logWebhookEvent({
    accountId: input.accountId,
    source: input.source,
    correlationId: input.correlationId,
    payload: input.payload,
    responseStatus: 200,
    responseBody:
      input.responseBody ?? `Allowed unsigned Twilio ${input.label} webhook by env override.`,
    error: `Unsigned/invalid Twilio signature. Candidate URLs: ${input.candidateUrls.join(" | ")}`,
  });

  if (process.env.NODE_ENV === "production") {
    await notifyAdminOperationalIssue({
      account: null,
      issue: `Unsigned Twilio ${input.label} webhook allowed`,
      detail: `Candidate URLs: ${input.candidateUrls.join(" | ")}`,
      correlationId: input.correlationId,
    });
  }
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
  return twilioWebhookUrlCandidates({
    requestUrl: request.url,
    appBaseUrl: env.appBaseUrl,
    forwardedOrigin: forwardedOrigin(request),
  });
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
    fromLast4: phoneLast4(payload.From),
    toLast4: phoneLast4(payload.To),
    dialCallStatus: payload.DialCallStatus ?? null,
    callMode: env.callMode,
    hasOwnerPhoneNumber: Boolean(env.ownerPhoneNumber),
    hasTwilioPhoneNumber: Boolean(env.twilioPhoneNumber),
  };
}
