import type {
  CallIdentifier,
  MessageIdentifier,
  NumberIdentifier,
  ProviderIdentifier,
  ProviderResourceKind,
  RecordingIdentifier,
  TelephonyProviderId,
} from "@/lib/telephony/types";
import { providerIdentifier } from "@/lib/telephony/types";

/**
 * Production telephony rows predate the provider abstraction. Their identifiers
 * are Twilio identifiers even when the column name is generic (call_sid,
 * recording_sid, and message_sid). Keep that fact centralized until the
 * additive provider-resource migration described in the operations runbook.
 */
export const LEGACY_TELEPHONY_PROVIDER_ID = "twilio" as const;

export class UnsupportedPersistedTelephonyProviderError extends Error {
  constructor(readonly provider: string) {
    super(`Unsupported persisted telephony provider: ${provider}`);
    this.name = "UnsupportedPersistedTelephonyProviderError";
  }
}

export function persistedTelephonyProviderId(value?: unknown): TelephonyProviderId {
  if (value == null || (typeof value === "string" && !value.trim())) {
    return LEGACY_TELEPHONY_PROVIDER_ID;
  }

  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized !== LEGACY_TELEPHONY_PROVIDER_ID) {
    throw new UnsupportedPersistedTelephonyProviderError(normalized || String(value));
  }

  return LEGACY_TELEPHONY_PROVIDER_ID;
}

/** Rolling-deploy bridge for runtime objects created before relayPhoneNumber existed. */
export function relayPhoneNumberFromRuntime(input: {
  relayPhoneNumber?: unknown;
  twilioPhoneNumber?: unknown;
}): string {
  const value = input.relayPhoneNumber ?? input.twilioPhoneNumber;
  return typeof value === "string" ? value.trim() : "";
}

function legacyIdentifier<Kind extends ProviderResourceKind>(
  kind: Kind,
  value: unknown,
  persistedProvider?: unknown,
): ProviderIdentifier<Kind> | null {
  if (typeof value !== "string" || !value.trim()) return null;

  return providerIdentifier({
    provider: persistedTelephonyProviderId(persistedProvider),
    kind,
    value,
  });
}

export type LegacyTelephonyRow = {
  provider?: unknown;
  phone_number?: unknown;
  twilio_sid?: unknown;
  call_sid?: unknown;
  twilio_message_sid?: unknown;
  message_sid?: unknown;
  recording_sid?: unknown;
};

export type NeutralTelephonyFields = {
  telephonyProvider: TelephonyProviderId;
  relayPhoneNumber: string;
  providerNumberId: NumberIdentifier | null;
  providerCallId: CallIdentifier | null;
  providerMessageId: MessageIdentifier | null;
  providerRecordingId: RecordingIdentifier | null;
};

/** Maps an existing database row to Relay-owned runtime names without rewriting it. */
export function mapLegacyTelephonyRow(row: LegacyTelephonyRow): NeutralTelephonyFields {
  const telephonyProvider = persistedTelephonyProviderId(row.provider);

  return {
    telephonyProvider,
    relayPhoneNumber: typeof row.phone_number === "string" ? row.phone_number.trim() : "",
    providerNumberId: legacyIdentifier("number", row.twilio_sid, telephonyProvider),
    providerCallId: legacyIdentifier("call", row.call_sid, telephonyProvider),
    providerMessageId: legacyIdentifier(
      "message",
      row.twilio_message_sid ?? row.message_sid,
      telephonyProvider,
    ),
    providerRecordingId: legacyIdentifier("recording", row.recording_sid, telephonyProvider),
  };
}

/**
 * Existing columns can only represent Twilio resources safely. This guard keeps
 * a future provider from being written into a legacy SID column by accident.
 */
export function legacyProviderValue<Kind extends ProviderResourceKind>(
  identifier: ProviderIdentifier<Kind> | null | undefined,
): string | null {
  if (!identifier) return null;
  if (identifier.provider !== LEGACY_TELEPHONY_PROVIDER_ID) {
    throw new UnsupportedPersistedTelephonyProviderError(identifier.provider);
  }
  if (!identifier.value.trim()) {
    throw new Error(`A ${identifier.kind} identifier requires a non-empty value.`);
  }
  return identifier.value.trim();
}
