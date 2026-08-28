import type { TelephonyProvider } from "@/lib/telephony/provider";
import type { TelephonyProviderId } from "@/lib/telephony/types";
import { twilioProvider } from "@/lib/telephony/providers/twilio";

export const DEFAULT_TELEPHONY_PROVIDER_ID = "twilio";

export function createTelephonyProviderRegistry(input: {
  providers: readonly TelephonyProvider[];
  defaultProviderId: TelephonyProviderId;
}) {
  const providers = new Map(input.providers.map((provider) => [provider.identity.id, provider]));

  if (!providers.has(input.defaultProviderId)) {
    throw new Error(`Default telephony provider is not registered: ${input.defaultProviderId}`);
  }

  return Object.freeze({
    defaultProviderId: input.defaultProviderId,
    get(providerId: TelephonyProviderId = input.defaultProviderId) {
      const provider = providers.get(providerId);
      if (!provider) {
        throw new Error(`Unknown telephony provider: ${providerId}`);
      }
      return provider;
    },
    list() {
      return [...providers.values()];
    },
  });
}

export const telephonyProviders = createTelephonyProviderRegistry({
  providers: [twilioProvider],
  defaultProviderId: DEFAULT_TELEPHONY_PROVIDER_ID,
});

export function getTelephonyProvider(providerId?: TelephonyProviderId) {
  return telephonyProviders.get(providerId);
}
