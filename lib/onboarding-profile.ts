export type CustomerProfileFacts = {
  businessName?: string | null;
  ownerName?: string | null;
  ownerEmail?: string | null;
  ownerPhoneNumber?: string | null;
  publicBusinessNumber?: string | null;
  businessType?: string | null;
  callMode?: string | null;
};

export function missingCustomerProfileFields(profile: CustomerProfileFacts) {
  const required: Array<[keyof CustomerProfileFacts, string]> = [
    ["businessName", "Business display name"],
    ["ownerEmail", "Notification email"],
    ["ownerPhoneNumber", "Owner alert phone"],
    ["callMode", "Call mode"],
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
