import { isPlaceholderSupabaseConfig, supabaseAdmin } from "./client";
import { assertAccountId } from "./tenant";

export type AccountOnboardingEvidence = {
  smsDeliveryVerifiedAt: string | null;
  smsDeliveryMessageSid: string | null;
  nonSmsFailureVerifiedAt: string | null;
  nonSmsFailureMessageSid: string | null;
  nonSmsFailureCode: string | null;
  ownerNotificationSentAt: string | null;
  ownerNotificationProviderId: string | null;
  ownerNotificationConfirmedAt: string | null;
  ownerNotificationConfirmedBy: string | null;
  customerGoLiveApprovedAt: string | null;
  customerGoLiveApprovedBy: string | null;
};

export const EMPTY_ONBOARDING_EVIDENCE: AccountOnboardingEvidence = {
  smsDeliveryVerifiedAt: null,
  smsDeliveryMessageSid: null,
  nonSmsFailureVerifiedAt: null,
  nonSmsFailureMessageSid: null,
  nonSmsFailureCode: null,
  ownerNotificationSentAt: null,
  ownerNotificationProviderId: null,
  ownerNotificationConfirmedAt: null,
  ownerNotificationConfirmedBy: null,
  customerGoLiveApprovedAt: null,
  customerGoLiveApprovedBy: null,
};

function missingEvidenceTable(error: { message?: string } | null | undefined) {
  return Boolean(error?.message?.includes("account_onboarding_evidence"));
}

export async function getAccountOnboardingEvidence(
  inputAccountId: string,
): Promise<AccountOnboardingEvidence> {
  const accountId = assertAccountId(inputAccountId, "getAccountOnboardingEvidence");
  if (isPlaceholderSupabaseConfig()) return { ...EMPTY_ONBOARDING_EVIDENCE };

  const { data, error } = await supabaseAdmin
    .from("account_onboarding_evidence")
    .select(
      "sms_delivery_verified_at, sms_delivery_message_sid, non_sms_failure_verified_at, non_sms_failure_message_sid, non_sms_failure_code, owner_notification_sent_at, owner_notification_provider_id, owner_notification_confirmed_at, owner_notification_confirmed_by, customer_go_live_approved_at, customer_go_live_approved_by",
    )
    .eq("account_id", accountId)
    .maybeSingle();

  if (missingEvidenceTable(error)) {
    console.warn("Onboarding evidence table is missing. Apply the repeatable-onboarding migration.");
    return { ...EMPTY_ONBOARDING_EVIDENCE };
  }
  if (error) throw error;
  if (!data) return { ...EMPTY_ONBOARDING_EVIDENCE };

  return {
    smsDeliveryVerifiedAt: data.sms_delivery_verified_at ?? null,
    smsDeliveryMessageSid: data.sms_delivery_message_sid ?? null,
    nonSmsFailureVerifiedAt: data.non_sms_failure_verified_at ?? null,
    nonSmsFailureMessageSid: data.non_sms_failure_message_sid ?? null,
    nonSmsFailureCode: data.non_sms_failure_code ?? null,
    ownerNotificationSentAt: data.owner_notification_sent_at ?? null,
    ownerNotificationProviderId: data.owner_notification_provider_id ?? null,
    ownerNotificationConfirmedAt: data.owner_notification_confirmed_at ?? null,
    ownerNotificationConfirmedBy: data.owner_notification_confirmed_by ?? null,
    customerGoLiveApprovedAt: data.customer_go_live_approved_at ?? null,
    customerGoLiveApprovedBy: data.customer_go_live_approved_by ?? null,
  };
}

async function upsertEvidence(
  inputAccountId: string,
  update: Record<string, string | null>,
) {
  const accountId = assertAccountId(inputAccountId, "upsertEvidence");
  if (isPlaceholderSupabaseConfig()) return false;

  const { error } = await supabaseAdmin
    .from("account_onboarding_evidence")
    .upsert(
      {
        account_id: accountId,
        ...update,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "account_id" },
    );

  if (missingEvidenceTable(error)) {
    console.warn("Onboarding evidence was not recorded because the migration is pending.", {
      accountId,
    });
    return false;
  }
  if (error) throw error;
  return true;
}

export async function recordSmsOnboardingEvidence(input: {
  accountId: string;
  messageSid: string;
  status: string;
  errorCode?: string | null;
  occurredAt?: string;
}) {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  if (input.status === "delivered") {
    return upsertEvidence(input.accountId, {
      sms_delivery_verified_at: occurredAt,
      sms_delivery_message_sid: input.messageSid,
    });
  }
  if (
    (input.status === "failed" || input.status === "undelivered") &&
    input.errorCode === "30006"
  ) {
    return upsertEvidence(input.accountId, {
      non_sms_failure_verified_at: occurredAt,
      non_sms_failure_message_sid: input.messageSid,
      non_sms_failure_code: input.errorCode,
    });
  }
  return false;
}

export async function recordOwnerNotificationSent(input: {
  accountId: string;
  providerId: string;
  occurredAt?: string;
}) {
  return upsertEvidence(input.accountId, {
    owner_notification_sent_at: input.occurredAt ?? new Date().toISOString(),
    owner_notification_provider_id: input.providerId,
  });
}

export async function recordCustomerOnboardingConfirmation(input: {
  accountId: string;
  action: "confirm_owner_notification" | "approve_go_live";
  userId: string;
  email: string | null;
  occurredAt?: string;
}) {
  const at = input.occurredAt ?? new Date().toISOString();
  return input.action === "confirm_owner_notification"
    ? upsertEvidence(input.accountId, {
      owner_notification_confirmed_at: at,
      owner_notification_confirmed_by: input.userId,
      owner_notification_confirmed_email: input.email,
    })
    : upsertEvidence(input.accountId, {
      customer_go_live_approved_at: at,
      customer_go_live_approved_by: input.userId,
      customer_go_live_approved_email: input.email,
    });
}

export async function clearCustomerGoLiveApproval(inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "clearCustomerGoLiveApproval");
  if (isPlaceholderSupabaseConfig()) return false;

  const { error } = await supabaseAdmin
    .from("account_onboarding_evidence")
    .update({
      customer_go_live_approved_at: null,
      customer_go_live_approved_by: null,
      customer_go_live_approved_email: null,
      updated_at: new Date().toISOString(),
    })
    .eq("account_id", accountId);

  if (missingEvidenceTable(error)) return false;
  if (error) throw error;
  return true;
}

export async function clearMessagingOnboardingEvidence(inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "clearMessagingOnboardingEvidence");
  if (isPlaceholderSupabaseConfig()) return false;

  const { error } = await supabaseAdmin
    .from("account_onboarding_evidence")
    .update({
      sms_delivery_verified_at: null,
      sms_delivery_message_sid: null,
      non_sms_failure_verified_at: null,
      non_sms_failure_message_sid: null,
      non_sms_failure_code: null,
      customer_go_live_approved_at: null,
      customer_go_live_approved_by: null,
      customer_go_live_approved_email: null,
      updated_at: new Date().toISOString(),
    })
    .eq("account_id", accountId);

  if (missingEvidenceTable(error)) return false;
  if (error) throw error;
  return true;
}

export async function clearOwnerNotificationEvidence(inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "clearOwnerNotificationEvidence");
  if (isPlaceholderSupabaseConfig()) return false;

  const { error } = await supabaseAdmin
    .from("account_onboarding_evidence")
    .update({
      owner_notification_sent_at: null,
      owner_notification_provider_id: null,
      owner_notification_confirmed_at: null,
      owner_notification_confirmed_by: null,
      owner_notification_confirmed_email: null,
      customer_go_live_approved_at: null,
      customer_go_live_approved_by: null,
      customer_go_live_approved_email: null,
      updated_at: new Date().toISOString(),
    })
    .eq("account_id", accountId);

  if (missingEvidenceTable(error)) return false;
  if (error) throw error;
  return true;
}

export async function hasLinkedOwnerAuth(inputAccountId: string) {
  const accountId = assertAccountId(inputAccountId, "hasLinkedOwnerAuth");
  if (isPlaceholderSupabaseConfig()) return false;

  const { data, error } = await supabaseAdmin
    .from("account_users")
    .select("id")
    .eq("account_id", accountId)
    .eq("role", "owner")
    .not("user_id", "is", null)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data?.id);
}
