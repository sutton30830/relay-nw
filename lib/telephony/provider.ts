import type {
  CanonicalTelephonyEvent,
  MessageDeliveryStatus,
  MessageIdentifier,
  NumberIdentifier,
  ProviderIdentifier,
  RecordingIdentifier,
  TelephonyEventType,
  TelephonyProviderId,
} from "@/lib/telephony/types";

export const TELEPHONY_CAPABILITY_KEYS = [
  "outboundSms",
  "messageDeliveryUpdates",
  "recordingAudio",
  "numberSearch",
  "numberConfiguration",
  "numberRelease",
  "messagingRegistrationEvidence",
  "signedWebhooks",
  "voiceInstructions",
] as const;

export type TelephonyCapabilityKey = (typeof TELEPHONY_CAPABILITY_KEYS)[number];
export type CapabilitySupport = "supported" | "relay_managed" | "unsupported";

export type TelephonyProviderCapabilities = Readonly<
  Record<TelephonyCapabilityKey, CapabilitySupport> & {
    smsIdempotency: "provider" | "relay_reservation";
  }
>;

export type TelephonyProviderIdentity = Readonly<{
  id: TelephonyProviderId;
  displayName: string;
}>;

export type DeliveryCallback = {
  url: string;
  metadata: Readonly<Record<string, string>>;
};

export type SendSmsInput = {
  from: string;
  to: string;
  body: string;
  /** Relay's durable reservation key. It must be stable across retries. */
  idempotencyKey: string;
  deliveryCallback: DeliveryCallback | null;
};

export type SendSmsResult = {
  messageId: MessageIdentifier;
  status: MessageDeliveryStatus;
  idempotencyKey: string;
};

export type RecordingAudio = {
  recordingId: RecordingIdentifier;
  audio: Blob;
  contentType: string | null;
  contentLength: number | null;
};

export type NumberCapabilities = {
  voice: boolean;
  sms: boolean;
};

export type AvailableNumber = {
  phoneNumber: string;
  locality: string | null;
  region: string | null;
  capabilities: NumberCapabilities;
};

export type FindNumbersInput = {
  countryCode: string;
  areaCode?: string;
  limit: number;
  requiredCapabilities: NumberCapabilities;
};

export type NumberWebhookConfiguration = {
  voice: {
    url: string;
    fallbackUrl: string;
  };
  messaging: {
    url: string;
  };
};

export type ConfiguredNumber = {
  numberId: NumberIdentifier;
  phoneNumber: string;
  capabilities: NumberCapabilities;
};

export type MessagingRegistrationEvidence = {
  registrationStatus: string;
  brandRegistrationReference: string | null;
  messagingServiceRegistered: boolean;
  numberInSenderPool: boolean;
  numberSmsCapable: boolean;
  issues: Array<{ code: string | null; message: string | null }>;
};

export type WebhookVerificationInput = {
  candidateUrls: readonly string[];
  headers: Readonly<Record<string, string | undefined>>;
  form: Readonly<Record<string, string>>;
  rawBody?: string;
};

export type WebhookVerificationResult = {
  isValid: boolean;
  matchedUrl: string | null;
  hasSignature: boolean;
};

export const RELAY_VOICE_INSTRUCTION_TYPES = [
  "forward_to_owner",
  "play_greeting",
  "capture_voicemail",
  "reject_safely",
] as const;

export type RelayVoiceInstruction =
  | {
      type: "forward_to_owner";
      ownerPhoneNumber: string;
      callerId: string;
      completionCallbackUrl: string;
      timeoutSeconds: number;
    }
  | {
      type: "play_greeting";
      greeting:
        | { type: "text"; text: string; voice: string }
        | { type: "audio"; url: string };
    }
  | {
      type: "capture_voicemail";
      completionCallbackUrl: string;
      maxDurationSeconds: number;
      silenceTimeoutSeconds: number;
      trimSilence: boolean;
      playBeep: boolean;
    }
  | {
      type: "reject_safely";
      message: string;
      voice: string;
    };

export type VoiceResponse = {
  body: string;
  contentType: string;
  status: number;
};

export interface TelephonyProvider {
  readonly identity: TelephonyProviderIdentity;
  readonly capabilities: TelephonyProviderCapabilities;

  sendSms(input: SendSmsInput): Promise<SendSmsResult>;
  fetchRecordingAudio(recordingId: RecordingIdentifier): Promise<RecordingAudio>;
  findNumbers(input: FindNumbersInput): Promise<AvailableNumber[]>;
  configureNumber(input: {
    phoneNumber: string;
    webhooks: NumberWebhookConfiguration;
  }): Promise<ConfiguredNumber>;
  releaseNumber(numberId: NumberIdentifier): Promise<"released" | "not_found">;
  readMessagingRegistrationEvidence(input: {
    messagingServiceReference: string;
    registrationReference: string;
    phoneNumber: string;
  }): Promise<MessagingRegistrationEvidence>;
  verifyWebhookSignature(input: WebhookVerificationInput): WebhookVerificationResult;
  normalizeWebhookEvent(input: {
    type: TelephonyEventType;
    payload: unknown;
    receivedAt?: string;
  }): CanonicalTelephonyEvent;
  renderVoiceInstructions(instructions: readonly RelayVoiceInstruction[]): VoiceResponse;

  /** Rejects identifiers belonging to another provider or resource type. */
  assertIdentifier<Kind extends ProviderIdentifier["kind"]>(
    identifier: ProviderIdentifier<Kind>,
    kind: Kind,
  ): ProviderIdentifier<Kind>;
}
