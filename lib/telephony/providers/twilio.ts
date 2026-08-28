import twilio from "twilio";
import { env } from "@/lib/env";
import type {
  AvailableNumber,
  CapabilitySupport,
  ConfiguredNumber,
  MessagingRegistrationEvidence,
  RelayVoiceInstruction,
  TelephonyProvider,
  TelephonyProviderCapabilities,
} from "@/lib/telephony/provider";
import {
  providerIdentifier,
  type CallCompletionOutcome,
  type CanonicalTelephonyEvent,
  type MessageDeliveryStatus,
  type ProviderIdentifier,
  type ProviderResourceKind,
  type TelephonyEventType,
} from "@/lib/telephony/types";
import { fetchA2pRegistrationEvidence, twilioClient } from "@/lib/twilio";

const PROVIDER_ID = "twilio";
const RECORDING_DOWNLOAD_TIMEOUT_MS = 15_000;

export const TWILIO_CAPABILITIES: TelephonyProviderCapabilities = Object.freeze({
  outboundSms: "supported",
  messageDeliveryUpdates: "supported",
  recordingAudio: "supported",
  numberSearch: "supported",
  numberConfiguration: "supported",
  numberRelease: "supported",
  messagingRegistrationEvidence: "supported",
  signedWebhooks: "supported",
  voiceInstructions: "supported",
  // Relay's durable provider-action reservation remains the idempotency authority.
  smsIdempotency: "relay_reservation",
} satisfies Record<string, CapabilitySupport | "provider" | "relay_reservation">);

type TwilioClientLike = {
  messages: {
    create(input: {
      from: string;
      to: string;
      body: string;
      statusCallback?: string;
    }): Promise<{ sid: string; status: string | null }>;
  };
  availablePhoneNumbers(countryCode: string): {
    local: {
      list(input: {
        areaCode?: number;
        voiceEnabled: boolean;
        smsEnabled: boolean;
        limit: number;
      }): Promise<Array<{
        phoneNumber: string;
        locality: string | null;
        region: string | null;
        capabilities: { voice: boolean; sms: boolean };
      }>>;
    };
  };
  incomingPhoneNumbers: {
    (sid: string): {
      update(input: {
        voiceUrl: string;
        voiceMethod: "POST";
        voiceFallbackUrl: string;
        voiceFallbackMethod: "POST";
        smsUrl: string;
        smsMethod: "POST";
      }): Promise<{
        sid: string;
        phoneNumber: string;
        capabilities?: { voice?: boolean; sms?: boolean };
      }>;
      remove(): Promise<boolean>;
    };
    list(input: { phoneNumber: string; limit: number }): Promise<Array<{
      sid: string;
      phoneNumber: string;
      capabilities?: { voice?: boolean; sms?: boolean };
    }>>;
  };
};

type TwilioProviderDependencies = {
  client: TwilioClientLike;
  accountSid: string;
  authToken: string;
  fetchImpl: typeof fetch;
  validateRequest: (
    authToken: string,
    signature: string,
    url: string,
    params: Record<string, string>,
  ) => boolean;
  fetchRegistrationEvidence: typeof fetchA2pRegistrationEvidence;
  createVoiceResponse: () => TwilioVoiceResponse;
};

type TwilioVoiceResponse = {
  dial(input: Record<string, unknown>): { number(value: string): unknown };
  say(input: Record<string, unknown>, value: string): unknown;
  play(value: string): unknown;
  record(input: Record<string, unknown>): unknown;
  hangup(): unknown;
  toString(): string;
};

function recordPayload(payload: unknown): Record<string, string> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Twilio webhook payload must be a field record.");
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function normalizedTimestamp(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function nonNegativeNumber(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function messageStatus(value: string | undefined): MessageDeliveryStatus {
  const normalized = value?.trim().toLowerCase();
  return normalized === "queued" || normalized === "sending" || normalized === "sent" ||
      normalized === "delivered" || normalized === "failed" || normalized === "undelivered"
    ? normalized
    : "unknown";
}

function callOutcome(value: string | undefined): CallCompletionOutcome {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "answered") return "answered";
  if (normalized === "completed") return "completed";
  if (normalized === "no-answer") return "no_answer";
  if (normalized === "busy") return "busy";
  if (normalized === "failed") return "failed";
  if (normalized === "canceled") return "canceled";
  return "unknown";
}

function registrationIssues(value: unknown) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((issue) => {
      if (!issue || typeof issue !== "object") {
        return { code: null, message: String(issue) };
      }
      const values = issue as Record<string, unknown>;
      return {
        code: values.code === undefined ? null : String(values.code),
        message: values.message === undefined ? null : String(values.message),
      };
    });
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([code, message]) => ({
      code,
      message: typeof message === "string" ? message : JSON.stringify(message) ?? null,
    }));
  }
  return [{ code: null, message: String(value) }];
}

function withCallbackMetadata(url: string, metadata: Readonly<Record<string, string>>) {
  const callback = new URL(url);
  for (const [key, value] of Object.entries(metadata)) callback.searchParams.set(key, value);
  return callback.toString();
}

function assertTwilioIdentifier<Kind extends ProviderResourceKind>(
  identifier: ProviderIdentifier<Kind>,
  kind: Kind,
) {
  if (identifier.provider !== PROVIDER_ID || identifier.kind !== kind || !identifier.value.trim()) {
    throw new Error(`Expected a Twilio ${kind} identifier.`);
  }
  return identifier;
}

function normalizeEvent(
  type: TelephonyEventType,
  payload: unknown,
  receivedAt = new Date().toISOString(),
): CanonicalTelephonyEvent {
  const fields = recordPayload(payload);
  const occurredAt = normalizedTimestamp(fields.Timestamp ?? fields.DateCreated, receivedAt);
  const providerEventId = (fields.EventSid ?? "").trim() || null;
  const base = { provider: PROVIDER_ID, occurredAt, receivedAt, providerEventId };
  const callId = () => providerIdentifier({ provider: PROVIDER_ID, kind: "call", value: fields.CallSid ?? "" });
  const parentCallId = () => (fields.ParentCallSid ?? "").trim()
    ? providerIdentifier({ provider: PROVIDER_ID, kind: "call", value: fields.ParentCallSid })
    : null;

  if (type === "inbound_call") {
    return {
      ...base,
      type,
      callId: callId(),
      parentCallId: parentCallId(),
      from: (fields.From ?? "").trim(),
      to: (fields.To ?? "").trim(),
    };
  }
  if (type === "call_completed") {
    return {
      ...base,
      type,
      callId: callId(),
      parentCallId: parentCallId(),
      from: (fields.From ?? "").trim(),
      to: (fields.To ?? "").trim(),
      outcome: callOutcome(fields.DialCallStatus ?? fields.CallStatus),
      durationSeconds: nonNegativeNumber(fields.DialCallDuration ?? fields.CallDuration),
    };
  }
  if (type === "recording_ready") {
    const rawStatus = (fields.RecordingStatus ?? "").trim().toLowerCase();
    return {
      ...base,
      type,
      recordingId: providerIdentifier({
        provider: PROVIDER_ID,
        kind: "recording",
        value: fields.RecordingSid ?? "",
      }),
      callId: callId(),
      durationSeconds: nonNegativeNumber(fields.RecordingDuration),
      status: rawStatus === "completed"
        ? "ready"
        : rawStatus === "in-progress"
          ? "processing"
          : rawStatus === "failed"
            ? "failed"
            : "unknown",
    };
  }
  if (type === "inbound_message") {
    return {
      ...base,
      type,
      messageId: providerIdentifier({
        provider: PROVIDER_ID,
        kind: "message",
        value: fields.MessageSid ?? fields.SmsSid ?? "",
      }),
      from: (fields.From ?? "").trim(),
      to: (fields.To ?? "").trim(),
      body: (fields.Body ?? "").trim(),
      mediaCount: nonNegativeNumber(fields.NumMedia) ?? 0,
    };
  }
  if (type !== "message_delivery_updated") {
    throw new Error(`Unsupported canonical telephony event type: ${type satisfies never}`);
  }
  return {
    ...base,
    type: "message_delivery_updated",
    messageId: providerIdentifier({
      provider: PROVIDER_ID,
      kind: "message",
      value: fields.MessageSid ?? fields.SmsSid ?? "",
    }),
    from: (fields.From ?? "").trim(),
    to: (fields.To ?? "").trim(),
    status: messageStatus(fields.MessageStatus ?? fields.SmsStatus),
    error: fields.ErrorCode || fields.ErrorMessage
      ? {
          code: (fields.ErrorCode ?? "").trim() || null,
          message: (fields.ErrorMessage ?? "").trim() || null,
        }
      : null,
  };
}

export function createTwilioProvider(
  dependencies: TwilioProviderDependencies,
): TelephonyProvider {
  const { client } = dependencies;

  return {
    identity: Object.freeze({ id: PROVIDER_ID, displayName: "Twilio" }),
    capabilities: TWILIO_CAPABILITIES,

    assertIdentifier: assertTwilioIdentifier,

    async sendSms(input) {
      if (!input.idempotencyKey.trim()) {
        throw new Error("Relay requires a non-empty SMS idempotency key.");
      }
      const statusCallback = input.deliveryCallback
        ? withCallbackMetadata(input.deliveryCallback.url, input.deliveryCallback.metadata)
        : undefined;
      const message = await client.messages.create({
        from: input.from,
        to: input.to,
        body: input.body,
        ...(statusCallback ? { statusCallback } : {}),
      });
      return {
        messageId: providerIdentifier({ provider: PROVIDER_ID, kind: "message", value: message.sid }),
        status: messageStatus(message.status ?? undefined),
        idempotencyKey: input.idempotencyKey,
      };
    },

    async fetchRecordingAudio(recordingId) {
      assertTwilioIdentifier(recordingId, "recording");
      const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(dependencies.accountSid)}/Recordings/${encodeURIComponent(recordingId.value)}.mp3`;
      const auth = Buffer.from(`${dependencies.accountSid}:${dependencies.authToken}`).toString("base64");
      const response = await dependencies.fetchImpl(url, {
        headers: { Authorization: `Basic ${auth}` },
        cache: "no-store",
        signal: AbortSignal.timeout(RECORDING_DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`Twilio recording download failed with ${response.status}.`);
      const contentLengthHeader = response.headers.get("content-length");
      const contentLength = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader);
      return {
        recordingId,
        audio: await response.blob(),
        contentType: response.headers.get("content-type"),
        contentLength: Number.isFinite(contentLength) ? contentLength : null,
      };
    },

    async findNumbers(input) {
      const areaCode = input.areaCode?.trim();
      if (areaCode && !/^\d{3}$/.test(areaCode)) {
        throw new Error("Enter a three-digit area code.");
      }
      const list = await client.availablePhoneNumbers(input.countryCode.toUpperCase()).local.list({
        ...(areaCode ? { areaCode: Number(areaCode) } : {}),
        voiceEnabled: input.requiredCapabilities.voice,
        smsEnabled: input.requiredCapabilities.sms,
        limit: Math.min(20, Math.max(1, input.limit)),
      });
      return list.map((number): AvailableNumber => ({
        phoneNumber: number.phoneNumber,
        locality: number.locality,
        region: number.region,
        capabilities: {
          voice: number.capabilities.voice,
          sms: number.capabilities.sms,
        },
      }));
    },

    async configureNumber(input) {
      const matches = await client.incomingPhoneNumbers.list({ phoneNumber: input.phoneNumber, limit: 2 });
      const existing = matches.find((number) => number.phoneNumber === input.phoneNumber);
      if (!existing) throw new Error("That number is not owned by the configured Twilio account.");
      const updated = await client.incomingPhoneNumbers(existing.sid).update({
        voiceUrl: input.webhooks.voice.url,
        voiceMethod: "POST",
        voiceFallbackUrl: input.webhooks.voice.fallbackUrl,
        voiceFallbackMethod: "POST",
        smsUrl: input.webhooks.messaging.url,
        smsMethod: "POST",
      });
      return {
        numberId: providerIdentifier({ provider: PROVIDER_ID, kind: "number", value: updated.sid }),
        phoneNumber: updated.phoneNumber,
        capabilities: {
          voice: updated.capabilities?.voice === true,
          sms: updated.capabilities?.sms === true,
        },
      } satisfies ConfiguredNumber;
    },

    async releaseNumber(numberId) {
      assertTwilioIdentifier(numberId, "number");
      try {
        await client.incomingPhoneNumbers(numberId.value).remove();
        return "released";
      } catch (error) {
        if (
          error && typeof error === "object" &&
          (("status" in error && error.status === 404) || ("code" in error && error.code === 20404))
        ) {
          return "not_found";
        }
        throw error;
      }
    },

    async readMessagingRegistrationEvidence(input) {
      const evidence = await dependencies.fetchRegistrationEvidence(
        input.messagingServiceReference,
        input.registrationReference,
        input.phoneNumber,
      );
      return {
        registrationStatus: evidence.campaignStatus,
        brandRegistrationReference: evidence.brandRegistrationSid ?? null,
        messagingServiceRegistered: evidence.serviceA2pRegistered,
        numberInSenderPool: evidence.relayNumberInSenderPool,
        numberSmsCapable: evidence.relayNumberSmsCapable,
        issues: registrationIssues(evidence.errors),
      } satisfies MessagingRegistrationEvidence;
    },

    verifyWebhookSignature(input) {
      const signatureEntry = Object.entries(input.headers).find(
        ([key]) => key.toLowerCase() === "x-twilio-signature",
      );
      const signature = signatureEntry?.[1]?.trim() ?? "";
      if (!signature) return { isValid: false, matchedUrl: null, hasSignature: false };
      for (const url of input.candidateUrls) {
        try {
          if (dependencies.validateRequest(dependencies.authToken, signature, url, { ...input.form })) {
            return { isValid: true, matchedUrl: url, hasSignature: true };
          }
        } catch {
          // A malformed candidate is invalid; try any remaining canonical URL.
        }
      }
      return { isValid: false, matchedUrl: null, hasSignature: true };
    },

    normalizeWebhookEvent(input) {
      return normalizeEvent(input.type, input.payload, input.receivedAt);
    },

    renderVoiceInstructions(instructions) {
      const response = dependencies.createVoiceResponse();
      for (const instruction of instructions) {
        renderInstruction(response, instruction);
      }
      return {
        body: response.toString(),
        contentType: "text/xml; charset=utf-8",
        status: 200,
      };
    },
  };
}

function renderInstruction(response: TwilioVoiceResponse, instruction: RelayVoiceInstruction) {
  if (instruction.type === "forward_to_owner") {
    const dial = response.dial({
      timeout: instruction.timeoutSeconds,
      action: instruction.completionCallbackUrl,
      method: "POST",
      callerId: instruction.callerId,
    });
    dial.number(instruction.ownerPhoneNumber);
    return;
  }
  if (instruction.type === "play_greeting") {
    if (instruction.greeting.type === "audio") response.play(instruction.greeting.url);
    else response.say({ voice: instruction.greeting.voice }, instruction.greeting.text);
    return;
  }
  if (instruction.type === "capture_voicemail") {
    response.record({
      action: instruction.completionCallbackUrl,
      method: "POST",
      recordingStatusCallback: instruction.completionCallbackUrl,
      recordingStatusCallbackMethod: "POST",
      recordingStatusCallbackEvent: ["completed"],
      maxLength: instruction.maxDurationSeconds,
      timeout: instruction.silenceTimeoutSeconds,
      trim: instruction.trimSilence ? "trim-silence" : "do-not-trim",
      playBeep: instruction.playBeep,
    });
    return;
  }
  response.say({ voice: instruction.voice }, instruction.message);
  response.hangup();
}

export const twilioProvider = createTwilioProvider({
  client: twilioClient,
  accountSid: env.twilioAccountSid,
  authToken: env.twilioAuthToken,
  fetchImpl: fetch,
  validateRequest: twilio.validateRequest,
  fetchRegistrationEvidence: fetchA2pRegistrationEvidence,
  createVoiceResponse: () => new twilio.twiml.VoiceResponse(),
});
