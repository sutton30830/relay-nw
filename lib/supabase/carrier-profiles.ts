import { shouldSkipDatabaseWrite, supabaseAdmin } from "./client";

export type CarrierProfileStatus = "draft" | "ready" | "submitted" | "in_progress" | "approved" | "needs_changes" | "rejected";

export type CarrierProfile = {
  accountId: string;
  status: CarrierProfileStatus;
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
    twilioBrandSid: typeof row.twilio_brand_sid === "string" ? row.twilio_brand_sid : null,
    twilioCampaignSid: typeof row.twilio_campaign_sid === "string" ? row.twilio_campaign_sid : null,
    messagingServiceSid: typeof row.messaging_service_sid === "string" ? row.messaging_service_sid : null,
    statusDetail: typeof row.status_detail === "string" ? row.status_detail : null,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

export async function getCarrierProfile(accountId: string): Promise<CarrierProfile | null> {
  const { data, error } = await supabaseAdmin
    .from("account_carrier_profiles")
    .select("account_id, status, twilio_brand_sid, twilio_campaign_sid, messaging_service_sid, status_detail, updated_at")
    .eq("account_id", accountId)
    .maybeSingle();
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
