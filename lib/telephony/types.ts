export const TELEPHONY_EVENT_TYPES = [
  "inbound_call",
  "call_completed",
  "recording_ready",
  "inbound_message",
  "message_delivery_updated",
] as const;

export type TelephonyEventType = (typeof TELEPHONY_EVENT_TYPES)[number];
export type TelephonyProviderId = "twilio" | "dial";
export type ProviderResourceKind = "call" | "message" | "recording" | "number";

/**
 * Provider identifiers are opaque. Relay associates their value with a provider
 * and resource kind instead of inferring meaning from vendor-specific prefixes.
 */
export type ProviderIdentifier<Kind extends ProviderResourceKind = ProviderResourceKind> = {
  provider: TelephonyProviderId;
  kind: Kind;
  value: string;
};

export type CallIdentifier = ProviderIdentifier<"call">;
export type MessageIdentifier = ProviderIdentifier<"message">;
export type RecordingIdentifier = ProviderIdentifier<"recording">;
export type NumberIdentifier = ProviderIdentifier<"number">;

export function providerIdentifier<Kind extends ProviderResourceKind>(input: {
  provider: TelephonyProviderId;
  kind: Kind;
  value: string;
}): ProviderIdentifier<Kind> {
  const provider = input.provider.trim().toLowerCase() as TelephonyProviderId;
  const value = input.value.trim();

  if (!/^[a-z][a-z0-9-]*$/.test(provider)) {
    throw new Error("A provider identifier requires a lowercase provider key.");
  }
  if (!value) {
    throw new Error(`A ${input.kind} identifier requires a non-empty value.`);
  }

  return { provider, kind: input.kind, value };
}

export function sameProviderIdentifier(
  left: ProviderIdentifier | null | undefined,
  right: ProviderIdentifier | null | undefined,
) {
  return Boolean(
    left && right &&
    left.provider === right.provider &&
    left.kind === right.kind &&
    left.value === right.value,
  );
}

type CanonicalEventBase<Type extends TelephonyEventType> = {
  type: Type;
  provider: TelephonyProviderId;
  occurredAt: string;
  receivedAt: string;
  providerEventId: string | null;
};

export type InboundCallEvent = CanonicalEventBase<"inbound_call"> & {
  callId: CallIdentifier;
  parentCallId: CallIdentifier | null;
  from: string;
  to: string;
};

export type CallCompletionOutcome =
  | "answered"
  | "completed"
  | "no_answer"
  | "busy"
  | "failed"
  | "canceled"
  | "unknown";

export type CallCompletionEvent = CanonicalEventBase<"call_completed"> & {
  callId: CallIdentifier;
  parentCallId: CallIdentifier | null;
  from: string;
  to: string;
  outcome: CallCompletionOutcome;
  durationSeconds: number | null;
};

export type RecordingReadyEvent = CanonicalEventBase<"recording_ready"> & {
  recordingId: RecordingIdentifier;
  callId: CallIdentifier;
  durationSeconds: number | null;
  status: "ready" | "processing" | "failed" | "unknown";
};

export type InboundMessageEvent = CanonicalEventBase<"inbound_message"> & {
  messageId: MessageIdentifier;
  from: string;
  to: string;
  body: string;
  mediaCount: number;
};

export type MessageDeliveryStatus =
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "failed"
  | "undelivered"
  | "unknown";

export type MessageDeliveryUpdateEvent = CanonicalEventBase<"message_delivery_updated"> & {
  messageId: MessageIdentifier;
  from: string;
  to: string;
  status: MessageDeliveryStatus;
  error: {
    code: string | null;
    message: string | null;
  } | null;
};

export type CanonicalTelephonyEvent =
  | InboundCallEvent
  | CallCompletionEvent
  | RecordingReadyEvent
  | InboundMessageEvent
  | MessageDeliveryUpdateEvent;
