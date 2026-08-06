export type OnboardingReadinessState =
  | "calls_not_configured"
  | "awaiting_forwarding_test"
  | "calls_verified"
  | "texting_registration_pending"
  | "texting_approved"
  | "sms_delivery_verified"
  | "ready_for_production"
  | "blocked";

export type OnboardingActionOwner =
  | "relay"
  | "customer"
  | "carrier"
  | "stripe"
  | "none";

export type OnboardingAction = {
  label: string;
  detail: string;
  href: string | null;
  owner: OnboardingActionOwner;
};

export type OnboardingCheckStatus = "complete" | "pending" | "blocked";

export type OnboardingCheck = {
  key:
    | "profile"
    | "relay_number"
    | "forwarding_plan"
    | "service_expectations"
    | "sms_copy"
    | "voicemail_greeting"
    | "sms_compliance"
    | "owner_auth"
    | "call_verification"
    | "a2p"
    | "automatic_texting"
    | "sms_delivery"
    | "non_sms_failure"
    | "owner_notification"
    | "billing"
    | "customer_approval";
  label: string;
  status: OnboardingCheckStatus;
  detail: string;
  evidenceAt?: string | null;
};

export type OnboardingFacts = {
  accountStatus: string | null | undefined;
  technicalStatus: string | null | undefined;
  callMode: "forwarding" | "direct";
  missingProfileFields: string[];
  relayNumber: string | null;
  forwardingCarrier: string | null;
  businessHoursConfigured: boolean;
  coverageExpectationsConfigured: boolean;
  smsTemplateConfigured: boolean;
  voicemailGreetingConfigured: boolean;
  smsComplianceConfigured: boolean;
  ownerAuthLinked: boolean;
  signedCallVerifiedAt: string | null;
  a2pStatus: string | null | undefined;
  smsEnabled: boolean;
  smsDeliveryVerifiedAt: string | null;
  smsDeliveryMessageSid: string | null;
  nonSmsFailureVerifiedAt: string | null;
  nonSmsFailureCode: string | null;
  ownerNotificationSentAt: string | null;
  ownerNotificationConfirmedAt: string | null;
  billingConfigured: boolean;
  billingAttentionReason: string | null;
  customerGoLiveApprovedAt: string | null;
  blockedBy: string | null | undefined;
  blockerReason: string | null;
};

export type OnboardingReadiness = {
  state: OnboardingReadinessState;
  stateLabel: string;
  ready: boolean;
  blockedBy: OnboardingActionOwner;
  blockerReason: string | null;
  checks: OnboardingCheck[];
  operatorAction: OnboardingAction;
  customerAction: OnboardingAction;
};

const STATE_LABELS: Record<OnboardingReadinessState, string> = {
  calls_not_configured: "Calls not configured",
  awaiting_forwarding_test: "Awaiting forwarding test",
  calls_verified: "Calls verified",
  texting_registration_pending: "Texting registration pending",
  texting_approved: "Texting approved",
  sms_delivery_verified: "SMS delivery verified",
  ready_for_production: "Ready for production",
  blocked: "Blocked",
};

function complete(value: boolean): OnboardingCheckStatus {
  return value ? "complete" : "pending";
}

function action(
  label: string,
  detail: string,
  owner: OnboardingActionOwner,
  href: string | null,
): OnboardingAction {
  return { label, detail, owner, href };
}

function normalizedBlocker(facts: OnboardingFacts): {
  owner: OnboardingActionOwner;
  reason: string | null;
} {
  if (facts.accountStatus === "paused" || facts.accountStatus === "archived") {
    return {
      owner: "relay",
      reason: facts.accountStatus === "archived" ? "Account is closed." : "Account service is paused.",
    };
  }
  if (facts.technicalStatus === "paused" || facts.technicalStatus === "closed") {
    return {
      owner: "relay",
      reason: facts.technicalStatus === "closed" ? "Call setup is closed." : "Call setup is paused.",
    };
  }
  if (facts.blockedBy === "relay" || facts.blockedBy === "customer" || facts.blockedBy === "carrier") {
    return {
      owner: facts.blockedBy,
      reason: facts.blockerReason?.trim() || "An explicit onboarding blocker needs resolution.",
    };
  }
  if (facts.a2pStatus === "needs_attention" || facts.a2pStatus === "rejected" || facts.a2pStatus === "paused") {
    return {
      owner: "carrier",
      reason:
        facts.a2pStatus === "rejected"
          ? "Carrier registration was rejected."
          : facts.a2pStatus === "paused"
            ? "Carrier registration is paused."
            : "Carrier registration needs attention.",
    };
  }
  if (facts.billingAttentionReason) {
    return { owner: "stripe", reason: facts.billingAttentionReason };
  }
  return { owner: "none", reason: null };
}

function buildChecks(facts: OnboardingFacts): OnboardingCheck[] {
  const profileComplete = facts.missingProfileFields.length === 0;
  const forwardingPlanComplete = facts.callMode === "direct" || Boolean(facts.forwardingCarrier);
  const serviceExpectationsComplete = facts.businessHoursConfigured && facts.coverageExpectationsConfigured;
  const a2pApproved = facts.a2pStatus === "approved";

  return [
    {
      key: "profile",
      label: "Business and owner profile",
      status: complete(profileComplete),
      detail: profileComplete
        ? "Legal/public names and owner contact details are complete."
        : `Missing: ${facts.missingProfileFields.join(", ")}.`,
    },
    {
      key: "relay_number",
      label: "Relay number assigned",
      status: complete(Boolean(facts.relayNumber)),
      detail: facts.relayNumber ?? "Assign an existing Twilio number to this account.",
    },
    {
      key: "forwarding_plan",
      label: "Call forwarding plan",
      status: complete(forwardingPlanComplete),
      detail: facts.callMode === "direct"
        ? "Direct mode uses the Relay number as the public number."
        : facts.forwardingCarrier
          ? `Conditional forwarding instructions selected for ${facts.forwardingCarrier}.`
          : "Record the customer's carrier before guiding conditional forwarding.",
    },
    {
      key: "service_expectations",
      label: "Hours and coverage expectations",
      status: complete(serviceExpectationsComplete),
      detail: serviceExpectationsComplete
        ? "Business hours and missed-call coverage expectations are recorded."
        : "Record both business hours and when Relay should cover missed calls.",
    },
    {
      key: "sms_copy",
      label: "Missed-call SMS wording",
      status: complete(facts.smsTemplateConfigured),
      detail: facts.smsTemplateConfigured
        ? "Account-specific missed-call wording is recorded."
        : "Review and record the customer-approved missed-call SMS wording.",
    },
    {
      key: "voicemail_greeting",
      label: "Voicemail greeting",
      status: complete(facts.voicemailGreetingConfigured),
      detail: facts.voicemailGreetingConfigured
        ? "A generated or recorded voicemail greeting is configured."
        : "Choose and review a disclosure-ready voicemail greeting.",
    },
    {
      key: "sms_compliance",
      label: "SMS consent and opt-out behavior",
      status: facts.smsComplianceConfigured ? "complete" : "blocked",
      detail: facts.smsComplianceConfigured
        ? "Consent disclosure, STOP handling, HELP response, and opt-out suppression are enabled."
        : "The required consent and opt-out controls are not available.",
    },
    {
      key: "owner_auth",
      label: "Owner authentication",
      status: complete(facts.ownerAuthLinked),
      detail: facts.ownerAuthLinked
        ? "An owner membership is linked to a Supabase Auth user."
        : "The invited owner must complete Supabase password setup and sign in.",
    },
    {
      key: "call_verification",
      label: "Signed real forwarding test",
      status: complete(Boolean(facts.signedCallVerifiedAt)),
      detail: facts.signedCallVerifiedAt
        ? "A valid signed missed call created a tenant-scoped lead."
        : "Place a real unanswered call through the published number; synthetic tests do not count.",
      evidenceAt: facts.signedCallVerifiedAt,
    },
    {
      key: "a2p",
      label: "A2P registration",
      status:
        facts.a2pStatus === "needs_attention" || facts.a2pStatus === "rejected" || facts.a2pStatus === "paused"
          ? "blocked"
          : complete(a2pApproved),
      detail: a2pApproved
        ? "Twilio/carrier registration is approved for this account's Relay number."
        : `Current carrier status: ${facts.a2pStatus ?? "not_started"}.`,
    },
    {
      key: "automatic_texting",
      label: "Automatic text-back enabled",
      status: complete(a2pApproved && facts.smsEnabled),
      detail: facts.smsEnabled
        ? "The owner enabled automatic text-back after carrier approval."
        : "Keep texting off until A2P is approved, then have the owner enable it.",
    },
    {
      key: "sms_delivery",
      label: "SMS delivery test",
      status: complete(Boolean(facts.smsDeliveryVerifiedAt)),
      detail: facts.smsDeliveryVerifiedAt
        ? `Twilio confirmed delivery${facts.smsDeliveryMessageSid ? ` for ${facts.smsDeliveryMessageSid}` : ""}.`
        : "Complete a real missed-call text and wait for Twilio's delivered callback.",
      evidenceAt: facts.smsDeliveryVerifiedAt,
    },
    {
      key: "non_sms_failure",
      label: "Non-SMS / landline failure test",
      status: complete(Boolean(facts.nonSmsFailureVerifiedAt)),
      detail: facts.nonSmsFailureVerifiedAt
        ? `Twilio reported a safe non-delivery${facts.nonSmsFailureCode ? ` (${facts.nonSmsFailureCode})` : ""}.`
        : "Use an approved non-SMS test number and confirm Relay records a safe failure without retrying blindly.",
      evidenceAt: facts.nonSmsFailureVerifiedAt,
    },
    {
      key: "owner_notification",
      label: "Owner notification test",
      status: complete(Boolean(facts.ownerNotificationConfirmedAt)),
      detail: facts.ownerNotificationConfirmedAt
        ? "The owner confirmed receiving the Relay notification test."
        : facts.ownerNotificationSentAt
          ? "Relay sent the test; the owner still needs to confirm receipt."
          : "Send an owner notification test from Operations, then ask the owner to confirm it.",
      evidenceAt: facts.ownerNotificationConfirmedAt ?? facts.ownerNotificationSentAt,
    },
    {
      key: "billing",
      label: "Billing or pilot terms configured",
      status: facts.billingAttentionReason ? "blocked" : complete(facts.billingConfigured),
      detail: facts.billingAttentionReason ?? (facts.billingConfigured
        ? "Stripe-backed billing or audited free-access terms are configured."
        : "Resolve setup terms and the Stripe payment method, or record audited free access."),
    },
    {
      key: "customer_approval",
      label: "Customer go-live approval",
      status: complete(Boolean(facts.customerGoLiveApprovedAt)),
      detail: facts.customerGoLiveApprovedAt
        ? "The authenticated owner explicitly approved production go-live."
        : "The authenticated owner must review the setup evidence and approve go-live.",
      evidenceAt: facts.customerGoLiveApprovedAt,
    },
  ];
}

function firstIncomplete(checks: OnboardingCheck[], keys: OnboardingCheck["key"][]) {
  return keys.map((key) => checks.find((check) => check.key === key)).find((check) => check?.status !== "complete");
}

function operatorNextAction(facts: OnboardingFacts, checks: OnboardingCheck[]): OnboardingAction {
  const profile = firstIncomplete(checks, ["profile", "forwarding_plan", "service_expectations", "sms_copy", "voicemail_greeting"]);
  if (profile) return action("Complete onboarding details", profile.detail, "relay", "#customer-details");
  if (checks.find((check) => check.key === "relay_number")?.status !== "complete") {
    return action("Assign the Relay number", "Attach and configure a number already owned in Twilio.", "relay", "#calls");
  }
  if (!facts.ownerAuthLinked) {
    return action("Finish owner login setup", "Resend the password invite if needed and confirm the owner signs in.", "customer", "#onboarding");
  }
  if (!facts.signedCallVerifiedAt) {
    return action(
      facts.callMode === "forwarding" ? "Run the real forwarding test" : "Run the real missed-call test",
      "Coordinate one real unanswered call and verify the signed webhook creates exactly one lead.",
      "customer",
      "#calls",
    );
  }
  if (facts.a2pStatus !== "approved") {
    return action(
      facts.a2pStatus === "in_progress" ? "Monitor carrier registration" : "Submit A2P registration",
      "Synchronize the authoritative Twilio campaign result; operators cannot approve it manually.",
      facts.a2pStatus === "in_progress" ? "carrier" : "relay",
      "#texting",
    );
  }
  if (!facts.smsEnabled) {
    return action("Have the owner enable text-back", "Carrier approval is complete; the owner controls activation in Settings.", "customer", "#texting");
  }
  if (!facts.smsDeliveryVerifiedAt) {
    return action("Verify SMS delivery", "Run a real missed-call text and wait for Twilio's delivered callback.", "relay", "#onboarding");
  }
  if (!facts.nonSmsFailureVerifiedAt) {
    return action("Verify non-SMS handling", "Use an approved landline/non-SMS destination and retain Twilio's safe failure code.", "relay", "#onboarding");
  }
  if (!facts.ownerNotificationSentAt) {
    return action("Send owner notification test", "Send the test from this workspace and ask the owner to confirm receipt.", "relay", "#onboarding");
  }
  if (!facts.ownerNotificationConfirmedAt) {
    return action("Ask owner to confirm notification", "The provider accepted the test; the owner must confirm receipt from Setup.", "customer", "/setup#approval");
  }
  if (!facts.billingConfigured) {
    return action("Finish billing setup", "Resolve setup terms and Stripe payment method or audited free access.", "relay", "#billing");
  }
  if (!facts.customerGoLiveApprovedAt) {
    return action("Request customer go-live approval", "Ask the authenticated owner to review the evidence and approve go-live.", "customer", "/setup#approval");
  }
  return action("No onboarding action needed", "Every required launch fact has authoritative evidence.", "none", null);
}

function customerNextAction(facts: OnboardingFacts, checks: OnboardingCheck[]): OnboardingAction {
  if (facts.callMode === "forwarding" && !facts.signedCallVerifiedAt) {
    return action("Enable forwarding and make a test call", "Follow the carrier instructions, then let one real call go unanswered.", "customer", "/setup#forwarding");
  }
  if (facts.a2pStatus === "approved" && !facts.smsEnabled) {
    return action("Enable automatic text-back", "Review the approved wording and turn texting on in Settings.", "customer", "/settings#texting");
  }
  if (facts.ownerNotificationSentAt && !facts.ownerNotificationConfirmedAt) {
    return action("Confirm your test notification", "Confirm that the Relay owner notification reached you.", "customer", "/setup#approval");
  }
  const approvalIsOnlyIncompleteCheck = checks.every(
    (check) => check.key === "customer_approval" || check.status === "complete",
  );
  if (!facts.customerGoLiveApprovedAt && approvalIsOnlyIncompleteCheck) {
    return action("Approve go-live", "Review the completed setup evidence and explicitly approve production use.", "customer", "/setup#approval");
  }
  if (!facts.customerGoLiveApprovedAt) {
    return action(
      "No action right now",
      "Relay is completing provider, test, and billing checks before asking for your approval.",
      "none",
      null,
    );
  }
  if (!approvalIsOnlyIncompleteCheck) {
    return action(
      "No action right now",
      "Relay is re-verifying changed or incomplete setup evidence before production readiness can return.",
      "none",
      null,
    );
  }
  return action("No action needed", "Relay has your approval and the required setup evidence.", "none", null);
}

export function deriveOnboardingReadiness(facts: OnboardingFacts): OnboardingReadiness {
  const checks = buildChecks(facts);
  const blocker = normalizedBlocker(facts);
  const allComplete = checks.every((check) => check.status === "complete");
  const blockedCheck = checks.find((check) => check.status === "blocked");

  let state: OnboardingReadinessState;
  if (blocker.owner !== "none" || blockedCheck) {
    state = "blocked";
  } else if (allComplete) {
    state = "ready_for_production";
  } else if (!facts.signedCallVerifiedAt) {
    state = facts.relayNumber && facts.missingProfileFields.length === 0
      ? "awaiting_forwarding_test"
      : "calls_not_configured";
  } else if (facts.smsDeliveryVerifiedAt && facts.a2pStatus === "approved") {
    state = "sms_delivery_verified";
  } else if (facts.a2pStatus === "approved") {
    state = "texting_approved";
  } else if (facts.a2pStatus === "in_progress") {
    state = "texting_registration_pending";
  } else {
    state = "calls_verified";
  }

  return {
    state,
    stateLabel: STATE_LABELS[state],
    ready: state === "ready_for_production",
    blockedBy: state === "blocked" ? (blocker.owner === "none" ? "relay" : blocker.owner) : "none",
    blockerReason:
      state === "blocked"
        ? blocker.reason ?? blockedCheck?.detail ?? "A required onboarding control is blocked."
        : null,
    checks,
    operatorAction:
      state === "blocked"
        ? action("Resolve onboarding blocker", blocker.reason ?? blockedCheck?.detail ?? "Resolve the blocked readiness check.", blocker.owner === "none" ? "relay" : blocker.owner, "#blocker")
        : operatorNextAction(facts, checks),
    customerAction:
      state === "blocked" && blocker.owner === "customer"
        ? action("Resolve your onboarding blocker", blocker.reason ?? "Relay needs information from you.", "customer", "/setup")
        : customerNextAction(facts, checks),
  };
}
