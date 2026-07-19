import { shouldSkipDatabaseWrite, supabaseAdmin } from "./client";

export type CarrierProfileStatus = "draft" | "ready" | "submitted" | "in_progress" | "approved" | "needs_changes" | "rejected";

export type CarrierProfile = {
  accountId: string;
  status: CarrierProfileStatus;
  hasEin: boolean | null;
  registrationType: string | null;
  registrationIdEncrypted: string | null;
  registrationIdLast4: string | null;
  representativeFirstName: string | null;
  representativeLastName: string | null;
  representativeTitle: string | null;
  representativeMobile: string | null;
  representativeEmail: string | null;
  messagingUseCase: string | null;
  optInFlow: string | null;
  sampleMessages: string[];
  privacyPolicyUrl: string | null;
  termsUrl: string | null;
  twilioBrandSid: string | null;
  twilioCampaignSid: string | null;
  messagingServiceSid: string | null;
  statusDetail: string | null;
  updatedAt: string | null;
};

function map(row: Record<string, unknown>): CarrierProfile {
  return {
    accountId: String(row.account_id),
    status: (row.status as CarrierProfileStatus) ?? "draft",
    hasEin: typeof row.has_ein === "boolean" ? row.has_ein : null,
    registrationType: typeof row.registration_type === "string" ? row.registration_type : null,
    registrationIdEncrypted: typeof row.registration_id_encrypted === "string" ? row.registration_id_encrypted : null,
    registrationIdLast4: typeof row.registration_id_last4 === "string" ? row.registration_id_last4 : null,
    representativeFirstName: typeof row.representative_first_name === "string" ? row.representative_first_name : null,
    representativeLastName: typeof row.representative_last_name === "string" ? row.representative_last_name : null,
    representativeTitle: typeof row.representative_title === "string" ? row.representative_title : null,
    representativeMobile: typeof row.representative_mobile === "string" ? row.representative_mobile : null,
    representativeEmail: typeof row.representative_email === "string" ? row.representative_email : null,
    messagingUseCase: typeof row.messaging_use_case === "string" ? row.messaging_use_case : null,
    optInFlow: typeof row.opt_in_flow === "string" ? row.opt_in_flow : null,
    sampleMessages: Array.isArray(row.sample_messages) ? row.sample_messages.map(String) : [],
    privacyPolicyUrl: typeof row.privacy_policy_url === "string" ? row.privacy_policy_url : null,
    termsUrl: typeof row.terms_url === "string" ? row.terms_url : null,
    twilioBrandSid: typeof row.twilio_brand_sid === "string" ? row.twilio_brand_sid : null,
    twilioCampaignSid: typeof row.twilio_campaign_sid === "string" ? row.twilio_campaign_sid : null,
    messagingServiceSid: typeof row.messaging_service_sid === "string" ? row.messaging_service_sid : null,
    statusDetail: typeof row.status_detail === "string" ? row.status_detail : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

export async function getCarrierProfile(accountId: string): Promise<CarrierProfile | null> {
  const { data, error } = await supabaseAdmin.from("account_carrier_profiles").select("*").eq("account_id", accountId).maybeSingle();
  if (error) {
    if (error.message.includes("account_carrier_profiles")) return null;
    throw error;
  }
  return data ? map(data as Record<string, unknown>) : null;
}

export async function upsertCarrierProfile(accountId: string, update: Record<string, unknown>) {
  if (shouldSkipDatabaseWrite("carrier profile", { accountId })) return;
  const { error } = await supabaseAdmin.from("account_carrier_profiles").upsert({
    account_id: accountId,
    ...update,
    updated_at: new Date().toISOString(),
  }, { onConflict: "account_id" });
  if (error) throw error;
}
