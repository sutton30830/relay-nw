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
    ["ownerName", "Owner or admin name"],
    ["ownerEmail", "Notification email"],
    ["ownerPhoneNumber", "Owner alert phone"],
    ["publicBusinessNumber", "Existing public business number"],
    ["businessType", "Business type"],
    ["callMode", "Call mode"],
  ];
  return required.filter(([key]) => !String(profile[key] ?? "").trim()).map(([, label]) => label);
}

export function isCustomerProfileComplete(profile: CustomerProfileFacts) {
  return missingCustomerProfileFields(profile).length === 0;
}
