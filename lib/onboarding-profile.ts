export type CustomerProfileFacts = {
  businessName?: string | null;
  legalBusinessName?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  ownerPhoneNumber?: string | null;
  publicBusinessNumber?: string | null;
  businessType?: string | null;
  callMode?: string | null;
  forwardingCarrier?: string | null;
  businessHours?: Record<string, unknown> | string | null;
  coverageExpectations?: string | null;
  smsTemplate?: string | null;
  missedCallVoiceMessage?: string | null;
  missedCallGreetingAudioUrl?: string | null;
};

export function hasConfiguredBusinessHours(value: CustomerProfileFacts["businessHours"]) {
  if (typeof value === "string") return Boolean(value.trim());
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

export function missingCustomerProfileFields(profile: CustomerProfileFacts) {
  // Call setup should ask only for facts Relay actually needs to connect the
  // customer's current number. Carrier, hours, messaging copy, legal/A2P
  // details, and custom greetings are optional or belong to later workflows.
  const required: Array<[keyof CustomerProfileFacts, string]> = [
    ["businessName", "Public business name"],
    ["ownerName", "Owner name"],
    ["ownerEmail", "Owner email"],
  ];
  const missing = required
    .filter(([key]) => !String(profile[key] ?? "").trim())
    .map(([, label]) => label);

  if (
    profile.callMode === "forwarding" &&
    !String(profile.publicBusinessNumber ?? "").trim()
  ) {
    missing.push("Existing public business number");
  }

  return missing;
}

export function isCustomerProfileComplete(profile: CustomerProfileFacts) {
  return missingCustomerProfileFields(profile).length === 0;
}
