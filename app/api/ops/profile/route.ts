import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import { normalizePhoneNumber } from "@/lib/phone";
import {
  getOpsAccountBySlug,
  getAccountConfigByAccountId,
  clearCustomerGoLiveApproval,
  clearMessagingOnboardingEvidence,
  clearOwnerNotificationEvidence,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  updateAccountSettings,
  updateAccountTechnicalSetupStatus,
  type AccountSettingsUpdate,
} from "@/lib/supabase";

// The operator's pen: Relay can enter or correct a customer's business details
// on their behalf (concierge onboarding), instead of leaving a 24-field form as
// customer homework. Same data model the owner's Settings writes — audited as
// entered by Relay.

function value(form: FormData, key: string, max = 200) {
  return String(form.get(key) ?? "").trim().slice(0, max);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.profileEdit);
  const form = await request.formData();
  const slug = value(form, "account_slug", 80);
  if (!slug) redirect("/ops");

  const account = await getOpsAccountBySlug(slug);
  if (!account) redirect("/ops");
  const previous = await getAccountConfigByAccountId(account.accountId);

  const businessName = value(form, "business_name", 120);
  const legalBusinessName = value(form, "legal_business_name", 160);
  const ownerName = value(form, "owner_name", 120);
  const ownerEmail = value(form, "owner_email").toLowerCase();
  const ownerPhone = value(form, "owner_phone_number", 30);
  const publicNumber = value(form, "public_business_number", 30);
  const businessType = value(form, "business_type", 40);
  const forwardingCarrier = value(form, "forwarding_carrier", 80);
  const businessHoursSummary = value(form, "business_hours_summary", 500);
  const coverageExpectations = value(form, "coverage_expectations", 500);
  const smsTemplate = value(form, "sms_template", 600);
  const callMode = value(form, "call_mode", 20);
  const effectiveCallMode = callMode === "forwarding" || callMode === "direct"
    ? callMode
    : previous?.callMode ?? "forwarding";
  const schedulingUrl = value(form, "scheduling_url", 500);

  if (
    !businessName ||
    !ownerName ||
    !ownerEmail ||
    (effectiveCallMode === "forwarding" && !publicNumber)
  ) {
    redirect(`/ops/accounts/${encodeURIComponent(slug)}?profile=invalid`);
  }
  if (ownerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
    redirect(`/ops/accounts/${encodeURIComponent(slug)}?profile=invalid`);
  }
  if (schedulingUrl && !/^https?:\/\//.test(schedulingUrl)) {
    redirect(`/ops/accounts/${encodeURIComponent(slug)}?profile=invalid`);
  }

  const update: AccountSettingsUpdate = {
    business_name: businessName,
    legal_business_name: legalBusinessName || null,
    owner_name: ownerName || null,
    owner_email: ownerEmail || null,
    public_business_number: publicNumber ? normalizePhoneNumber(publicNumber) : null,
    business_type: businessType || null,
    forwarding_carrier: effectiveCallMode === "forwarding" ? forwardingCarrier || null : null,
    business_hours: businessHoursSummary ? { summary: businessHoursSummary } : null,
    // Coverage expectations document the customer's operating agreement in
    // either call mode. Preserve the value only for older clients that do not
    // submit this field; the current Ops form can intentionally clear it.
    coverage_expectations: form.has("coverage_expectations")
      ? coverageExpectations || null
      : previous?.coverageExpectations ?? null,
    sms_template: smsTemplate || null,
    scheduling_url: schedulingUrl || null,
  };
  if (ownerPhone) update.owner_phone_number = normalizePhoneNumber(ownerPhone);
  update.call_mode = effectiveCallMode;

  const voiceMessage = value(form, "missed_call_voice_message", 600);
  update.missed_call_voice_message = voiceMessage || null;
  const dialTimeout = Number(value(form, "dial_timeout_seconds", 5));
  if (Number.isInteger(dialTimeout) && dialTimeout >= 5 && dialTimeout <= 60) {
    update.dial_timeout_seconds = dialTimeout;
  }
  const voicemailMax = Number(value(form, "voicemail_max_seconds", 5));
  if (Number.isInteger(voicemailMax) && voicemailMax >= 10 && voicemailMax <= 300) {
    update.voicemail_max_seconds = voicemailMax;
  }

  try {
    await updateAccountSettings(account.accountId, update);
    // Adding setup notes (including the carrier) or filling in a previously
    // blank public number does not undo a signed forwarding test. Re-verify
    // only when the actual routing contract changes: switching call modes or
    // replacing a business number that was already in service.
    const publicNumberReplaced = Boolean(
      previous?.publicBusinessNumber &&
      update.public_business_number &&
      previous.publicBusinessNumber !== update.public_business_number
    );
    const routingChanged = previous !== null && (
      previous.callMode !== effectiveCallMode || publicNumberReplaced
    );
    const messagingChanged = previous !== null &&
      (previous.smsTemplate ?? "") !== (update.sms_template ?? "");
    const ownerEmailChanged = previous !== null &&
      (previous.ownerEmail ?? "").toLowerCase() !== (update.owner_email ?? "").toLowerCase();

    if (routingChanged) {
      await updateAccountTechnicalSetupStatus(
        account.accountId,
        effectiveCallMode === "forwarding" ? "waiting_for_forwarding" : "setting_up",
      );
    }
    if (messagingChanged) await clearMessagingOnboardingEvidence(account.accountId);
    if (ownerEmailChanged) await clearOwnerNotificationEvidence(account.accountId);
    if (!messagingChanged && !ownerEmailChanged) {
      await clearCustomerGoLiveApproval(account.accountId);
    }
  } catch (error) {
    console.error("Ops profile update failed", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    redirect(`/ops/accounts/${encodeURIComponent(slug)}?profile=save_failed`);
  }

  const summary = `Relay entered business details for ${businessName}`;
  await recordAccountAuditEvents({
    accountId: account.accountId,
    actorUserId: operator.userId,
    actorEmail: operator.email,
    events: [{ action: "ops.profile_updated", summary }],
  });
  await recordPlatformAuditEvent({
    actorUserId: operator.userId,
    actorEmail: operator.email,
    targetAccountId: account.accountId,
    action: "ops.profile_updated",
    summary,
  });

  redirect(`/ops/accounts/${encodeURIComponent(slug)}?profile=saved`);
}
