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
  // Texting and billing have their own visible states. Neither should make a
  // working missed-call service look globally blocked.
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
      status: complete(a2pApproved),
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
      status: complete(facts.billingConfigured && !facts.billingAttentionReason),
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
  const profile = firstIncomplete(checks, ["profile"]);
  if (profile) return action("Complete onboarding details", profile.detail, "relay", "#customer-details");
  if (checks.find((check) => check.key === "relay_number")?.status !== "complete") {
    return action("Assign the Relay number", "Attach and configure a number already owned in Twilio.", "relay", "#calls");
  }
  if (!facts.signedCallVerifiedAt) {
    return action(
      facts.callMode === "forwarding" ? "Connect call forwarding" : "Test the Relay number",
      facts.callMode === "forwarding"
        ? "Help the customer turn on conditional forwarding, then let one real call go unanswered. Relay verifies the connection automatically."
        : "Let one real call go unanswered so Relay can verify the inbox.",
      "customer",
      "#calls",
    );
  }
  if (facts.a2pStatus !== "approved") {
    const a2pNeedsAttention = facts.a2pStatus === "needs_attention" || facts.a2pStatus === "rejected" || facts.a2pStatus === "paused";
    return action(
      a2pNeedsAttention
        ? "Review A2P in Twilio"
        : facts.a2pStatus === "in_progress"
          ? "A2P is pending"
          : "Start A2P in Twilio",
      a2pNeedsAttention
        ? "Calls remain covered. Review Twilio's response before enabling automatic text-back."
        : facts.a2pStatus === "in_progress"
        ? "Calls are already covered. Twilio is reviewing automatic text-back separately."
        : "Calls are already covered. Complete registration in Twilio, then sync the status here.",
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
  return action("Setup complete", "Calls are covered and automatic text-back has been delivery verified.", "none", null);
}

function customerNextAction(facts: OnboardingFacts): OnboardingAction {
  if (facts.callMode === "forwarding" && !facts.signedCallVerifiedAt) {
    return action("Turn on missed-call forwarding", "Your phone still rings first. Relay answers only when you do not, then verifies the connection automatically.", "customer", "/setup#forwarding");
  }
  if (facts.a2pStatus === "approved" && !facts.smsEnabled) {
    return action("Enable automatic text-back", "Review the approved wording and turn texting on in Settings.", "customer", "/settings#texting");
  }
  return action("No action needed", "Your missed calls are covered. Relay handles texting setup separately.", "none", null);
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
        : customerNextAction(facts),
  };
}
