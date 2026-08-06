import twilio from "twilio";
import { env } from "@/lib/env";
import { notifyAdminOperationalIssue } from "@/lib/email";
import { logWebhookEvent, type WebhookEventSource } from "@/lib/supabase";
import type { AccountRuntimeConfig } from "@/lib/supabase/accounts";

async function providerActionTools() {
  return import("@/lib/supabase/provider-actions");
}

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

export const twilioClient = twilio(env.twilioAccountSid, env.twilioAuthToken);

export async function fetchA2pRegistrationEvidence(
  messagingServiceSid: string,
  campaignSid: string,
  relayPhoneNumber: string,
) {
  if (!/^MG[0-9a-fA-F]{32}$/.test(messagingServiceSid)) {
    throw new Error("Invalid Twilio Messaging Service SID.");
  }
  if (!/^QE[0-9a-fA-F]{32}$/.test(campaignSid)) {
    throw new Error("Invalid Twilio A2P Campaign SID.");
  }
  if (!/^\+[1-9]\d{7,14}$/.test(relayPhoneNumber)) {
    throw new Error("A valid Relay phone number is required for A2P verification.");
  }

  const serviceContext = twilioClient.messaging.v1.services(messagingServiceSid);
  const [campaign, service, servicePhoneNumbers, incomingPhoneNumbers] = await Promise.all([
    serviceContext.usAppToPerson(campaignSid).fetch(),
    serviceContext.fetch(),
    serviceContext.phoneNumbers.list({ limit: 1000 }),
    twilioClient.incomingPhoneNumbers.list({ phoneNumber: relayPhoneNumber, limit: 2 }),
  ]);
  const incomingNumber = incomingPhoneNumbers.find(
    (number) => number.phoneNumber === relayPhoneNumber,
  );

  return {
    campaignStatus: campaign.campaignStatus,
    brandRegistrationSid: campaign.brandRegistrationSid,
    errors: campaign.errors,
    serviceA2pRegistered: service.usAppToPersonRegistered === true,
    relayNumberInSenderPool: servicePhoneNumbers.some(
      (number) => number.phoneNumber === relayPhoneNumber,
    ),
    relayNumberSmsCapable: incomingNumber?.capabilities?.sms === true,
  };
}

export async function findAvailableRelayNumbers(areaCode: string, limit = 8) {
  if (!/^\d{3}$/.test(areaCode)) throw new Error("Enter a three-digit area code.");
  const numbers = await twilioClient.availablePhoneNumbers("US").local.list({
    areaCode: Number(areaCode),
    voiceEnabled: true,
    smsEnabled: true,
    limit: Math.min(20, Math.max(1, limit)),
  });
  return numbers.map((number) => ({ phoneNumber: number.phoneNumber, locality: number.locality, region: number.region }));
}

export async function configureExistingRelayNumber(phoneNumber: string) {
  const matches = await twilioClient.incomingPhoneNumbers.list({ phoneNumber, limit: 2 });
  const existing = matches.find((number) => number.phoneNumber === phoneNumber);
  if (!existing) throw new Error("That number is not owned by the configured Twilio account.");
  const base = env.appBaseUrl;
  const updated = await twilioClient.incomingPhoneNumbers(existing.sid).update({
    voiceUrl: `${base}/api/twilio/voice`,
    voiceMethod: "POST",
    voiceFallbackUrl: `${base}/api/twilio/voice`,
    voiceFallbackMethod: "POST",
    smsUrl: `${base}/api/twilio/sms`,
    smsMethod: "POST",
  });
  return { sid: updated.sid, phoneNumber: updated.phoneNumber };
}

// Texts the owner from the account's Relay number. Never throws — notification
// failures must not disturb the pipeline that called this. Gated on smsEnabled:
// owner texts ride the same A2P-gated number as customer texting.
export async function sendOwnerSms(input: {
  account: Pick<AccountRuntimeConfig, "accountId" | "smsEnabled" | "ownerPhoneNumber" | "twilioPhoneNumber">;
  body: string;
  context: string;
  actionKey?: string;
}) {
  const { account } = input;
  const tools = await providerActionTools().catch((error) => {
    console.error("Owner SMS recovery tools could not be loaded", {
      context: input.context,
      error: error instanceof Error ? error.message : error,
    });
    return null;
  });
  const claimProviderActionRetry = tools?.claimProviderActionRetry;
  const recordProviderAction = tools?.recordProviderAction;

  if (!account.smsEnabled || !account.ownerPhoneNumber || !account.twilioPhoneNumber) {
    if (account.accountId && typeof recordProviderAction === "function") {
      try {
        await recordProviderAction({
          accountId: account.accountId,
          action: "owner_sms_notification",
          provider: "twilio",
          idempotencyKey: input.actionKey ?? `owner_sms:${input.context}`,
          internalStatus: "suppressed",
          providerStatus: "notification_not_configured",
          customerExplanation: "Relay could not send the owner text because texting setup is incomplete.",
          retryEligibility: "manual",
          recommendedNextAction: "Verify A2P approval and the owner mobile number, then run a notification test.",
          customerVisible: true,
          expectedSuppression: true,
        });
      } catch (recordError) {
        console.error("Could not record skipped owner SMS", {
          accountId: account.accountId,
          context: input.context,
          error: recordError instanceof Error ? recordError.message : recordError,
        });
      }
    }
    return false;
  }

  try {
    if (
      account.accountId
      && typeof recordProviderAction === "function"
      && typeof claimProviderActionRetry === "function"
    ) {
      try {
        await recordProviderAction({
          accountId: account.accountId,
          action: "owner_sms_notification",
          provider: "twilio",
          idempotencyKey: input.actionKey ?? `owner_sms:${input.context}`,
          internalStatus: "pending",
          providerStatus: "not_sent",
          customerExplanation: "Relay is preparing the owner text notification.",
          retryEligibility: "manual",
          recommendedNextAction: "Wait for provider acceptance before retrying.",
          customerVisible: false,
        });
        const claimed = await claimProviderActionRetry({
          accountId: account.accountId,
          idempotencyKey: input.actionKey ?? `owner_sms:${input.context}`,
          staleBefore: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        });
        if (!claimed) {
          console.info("Owner SMS duplicate suppressed by idempotency reservation", {
            accountId: account.accountId,
            context: input.context,
          });
          return true;
        }
      } catch (recordError) {
        console.error("Owner SMS action reservation failed; notification was not sent", {
          accountId: account.accountId,
          context: input.context,
          error: recordError instanceof Error ? recordError.message : recordError,
        });
        return false;
      }
    }
    const message = await twilioClient.messages.create({
      to: account.ownerPhoneNumber,
      from: account.twilioPhoneNumber,
      body: input.body,
    });
    if (account.accountId && typeof recordProviderAction === "function") {
      try {
        await recordProviderAction({
          accountId: account.accountId,
          action: "owner_sms_notification",
          provider: "twilio",
          idempotencyKey: input.actionKey ?? `owner_sms:${input.context}`,
          providerIdentifier: message.sid,
          internalStatus: "accepted",
          providerStatus: message.status || "accepted",
          customerExplanation: "Twilio accepted the owner text notification.",
          retryEligibility: "never",
          recommendedNextAction: "No retry is needed unless the owner reports non-delivery.",
          customerVisible: false,
        });
      } catch (recordError) {
        console.error("Twilio accepted owner SMS, but Relay could not update action evidence", {
          accountId: account.accountId,
          context: input.context,
          twilioMessageSid: message.sid,
          error: recordError instanceof Error ? recordError.message : recordError,
        });
      }
    }
    return true;
  } catch (error) {
    console.error("Owner SMS failed", {
      context: input.context,
      ownerLast4: phoneLast4(account.ownerPhoneNumber),
      error: error instanceof Error ? error.message : error,
    });
    if (account.accountId && typeof recordProviderAction === "function") {
      try {
        await recordProviderAction({
          accountId: account.accountId,
          action: "owner_sms_notification",
          provider: "twilio",
          idempotencyKey: input.actionKey ?? `owner_sms:${input.context}`,
          internalStatus: "failed",
          providerStatus: "send_failed",
          diagnosticDetail: error,
          customerVisible: true,
        });
      } catch (recordError) {
        console.error("Could not record owner SMS failure", {
          accountId: account.accountId,
          context: input.context,
          error: recordError instanceof Error ? recordError.message : recordError,
        });
      }
    }
    return false;
  }
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

export function phoneLast4(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) {
    return null;
  }

  return digits.slice(-4);
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
