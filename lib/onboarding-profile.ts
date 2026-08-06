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
  const required: Array<[keyof CustomerProfileFacts, string]> = [
    ["legalBusinessName", "Legal business name"],
    ["businessName", "Public business name"],
    ["ownerName", "Owner name"],
    ["ownerEmail", "Owner email"],
    ["ownerPhoneNumber", "Owner mobile number"],
    ["callMode", "Call mode"],
    ["coverageExpectations", "Coverage expectations"],
    ["smsTemplate", "Missed-call SMS wording"],
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

  if (
    profile.callMode === "forwarding" &&
    !String(profile.forwardingCarrier ?? "").trim()
  ) {
    missing.push("Forwarding carrier");
  }

  if (!hasConfiguredBusinessHours(profile.businessHours)) {
    missing.push("Business hours");
  }

  if (
    !String(profile.missedCallVoiceMessage ?? "").trim() &&
    !String(profile.missedCallGreetingAudioUrl ?? "").trim()
  ) {
    missing.push("Voicemail greeting");
  }

  return missing;
}

export function isCustomerProfileComplete(profile: CustomerProfileFacts) {
  return missingCustomerProfileFields(profile).length === 0;
}
