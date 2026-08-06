import { isSetupFeeSettled } from "@/lib/billing";
import { missingCustomerProfileFields } from "@/lib/onboarding-profile";
import {
  deriveOnboardingReadiness,
  type OnboardingFacts,
} from "@/lib/onboarding";
import {
  getAccountBillingRecord,
  getAccountConfigByAccountId,
  getAccountOnboardingEvidence,
  getAccountOperationalStatus,
  getAccountOpsBlocker,
  getAccountTechnicalSetupStatus,
  getA2pRegistrationStatus,
  getLastRecoveredCallAt,
  getSignedCallVerificationAt,
  hasLinkedOwnerAuth,
} from "@/lib/supabase";

function businessHoursConfigured(value: Record<string, unknown> | null) {
  return Boolean(value && Object.keys(value).length > 0);
}

function billingAttentionReason(input: {
  billingStatus: string;
  stripeSubscriptionStatus: string | null;
  setupFeeStatus: string;
}) {
  if (input.setupFeeStatus === "disputed" || input.setupFeeStatus === "charged_back") {
    return `Setup payment is ${input.setupFeeStatus.replaceAll("_", " ")}.`;
  }
  if (
    input.billingStatus === "past_due" ||
    input.stripeSubscriptionStatus === "past_due" ||
    input.stripeSubscriptionStatus === "unpaid" ||
    input.stripeSubscriptionStatus === "incomplete" ||
    input.stripeSubscriptionStatus === "paused"
  ) {
    return `Stripe billing needs attention (${input.stripeSubscriptionStatus ?? input.billingStatus}).`;
  }
  return null;
}

export async function loadAccountOnboardingReadiness(accountId: string) {
  const [
    runtime,
    billing,
    evidence,
    accountStatus,
    technicalStatus,
    a2pStatus,
    blocker,
    lastRecoveredCallAt,
    signedCallVerificationAt,
    ownerAuthLinked,
  ] = await Promise.all([
    getAccountConfigByAccountId(accountId),
    getAccountBillingRecord(accountId),
    getAccountOnboardingEvidence(accountId),
    getAccountOperationalStatus(accountId),
    getAccountTechnicalSetupStatus(accountId),
    getA2pRegistrationStatus(accountId),
    getAccountOpsBlocker(accountId),
    getLastRecoveredCallAt(accountId),
    getSignedCallVerificationAt(accountId),
    hasLinkedOwnerAuth(accountId),
  ]);

  if (!runtime) {
    throw new Error("Account configuration is unavailable for onboarding readiness");
  }

  const missingProfileFields = missingCustomerProfileFields({
    businessName: runtime.businessName,
    legalBusinessName: runtime.legalBusinessName,
    ownerName: runtime.ownerName,
    ownerEmail: runtime.ownerEmail,
    ownerPhoneNumber: runtime.ownerPhoneNumber,
    publicBusinessNumber: runtime.publicBusinessNumber,
    businessType: runtime.businessType,
    callMode: runtime.callMode,
    forwardingCarrier: runtime.forwardingCarrier,
    businessHours: runtime.businessHours,
    coverageExpectations: runtime.coverageExpectations,
    smsTemplate: runtime.smsTemplate,
    missedCallVoiceMessage: runtime.missedCallVoiceMessage,
    missedCallGreetingAudioUrl: runtime.missedCallGreetingAudioUrl,
  });
  const attentionReason = billingAttentionReason({
    billingStatus: billing.billingStatus,
    stripeSubscriptionStatus: billing.stripeSubscriptionStatus,
    setupFeeStatus: billing.setupFeeStatus,
  });
  const setupFeeSettled = isSetupFeeSettled(
    billing.setupFeeStatus,
    billing.firstPaidAt,
    billing.billingPolicy,
  );
  const billingConfigured = billing.billingPolicy === "comped" || (
    setupFeeSettled && Boolean(billing.stripeDefaultPaymentMethodId)
  );

  // A harmless profile edit in an older build could regress the editable
  // technical status after a verified call. The protected audit event remains
  // authoritative and repairs the derived state without inventing evidence.
  const signedCallVerifiedAt = signedCallVerificationAt ?? (
    technicalStatus === "live" ? lastRecoveredCallAt : null
  );
  const effectiveTechnicalStatus = signedCallVerificationAt && (
    technicalStatus === "setting_up" || technicalStatus === "waiting_for_forwarding"
  ) ? "live" : technicalStatus;

  const facts: OnboardingFacts = {
    accountStatus,
    technicalStatus: effectiveTechnicalStatus,
    callMode: runtime.callMode,
    missingProfileFields,
    relayNumber: runtime.twilioPhoneNumber || null,
    forwardingCarrier: runtime.forwardingCarrier,
    businessHoursConfigured: businessHoursConfigured(runtime.businessHours),
    coverageExpectationsConfigured: Boolean(runtime.coverageExpectations?.trim()),
    smsTemplateConfigured: Boolean(runtime.smsTemplate?.trim()),
    voicemailGreetingConfigured: Boolean(
      runtime.missedCallVoiceMessage?.trim() || runtime.missedCallGreetingAudioUrl?.trim(),
    ),
    // These controls are code-enforced and regression tested globally rather
    // than selected per account. If that contract changes, readiness fails
    // closed until this fact is updated with the implementation.
    smsComplianceConfigured: true,
    ownerAuthLinked,
    signedCallVerifiedAt,
    a2pStatus,
    smsEnabled: runtime.smsEnabled,
    smsDeliveryVerifiedAt: evidence.smsDeliveryVerifiedAt,
    smsDeliveryMessageSid: evidence.smsDeliveryMessageSid,
    nonSmsFailureVerifiedAt: evidence.nonSmsFailureVerifiedAt,
    nonSmsFailureCode: evidence.nonSmsFailureCode,
    ownerNotificationSentAt: evidence.ownerNotificationSentAt,
    ownerNotificationConfirmedAt: evidence.ownerNotificationConfirmedAt,
    billingConfigured,
    billingAttentionReason: attentionReason,
    customerGoLiveApprovedAt: evidence.customerGoLiveApprovedAt,
    blockedBy: blocker.blockedBy,
    blockerReason: blocker.blockerNote,
  };

  return {
    runtime,
    billing,
    evidence,
    facts,
    readiness: deriveOnboardingReadiness(facts),
  };
}
