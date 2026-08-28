export type A2pSyncEvidence = {
  registrationStatus: string | null | undefined;
  messagingServiceRegistered: boolean;
  numberInSenderPool: boolean;
  numberSmsCapable: boolean;
};

export type A2pSyncDecision = {
  profile: "in_progress" | "approved" | "needs_changes" | "rejected";
  a2p: "in_progress" | "approved" | "needs_attention" | "rejected";
  detail: string;
};

export function deriveA2pSyncDecision(evidence: A2pSyncEvidence): A2pSyncDecision | null {
  const campaignStatus = (evidence.registrationStatus ?? "").toUpperCase();

  if (campaignStatus === "FAILED" || campaignStatus === "SUSPENDED") {
    return {
      profile: "rejected",
      a2p: "rejected",
      detail: "Twilio reports that this A2P campaign needs attention.",
    };
  }

  if (
    campaignStatus === "PENDING" ||
    campaignStatus === "IN_PROGRESS" ||
    campaignStatus === "IN_REVIEW"
  ) {
    return {
      profile: "in_progress",
      a2p: "in_progress",
      detail: "Twilio or the carrier is reviewing this A2P campaign.",
    };
  }

  if (campaignStatus !== "VERIFIED") return null;

  if (!evidence.messagingServiceRegistered) {
    return {
      profile: "in_progress",
      a2p: "in_progress",
      detail: "The campaign is verified, but Twilio does not report this Messaging Service as A2P registered.",
    };
  }

  if (!evidence.numberInSenderPool) {
    return {
      profile: "needs_changes",
      a2p: "needs_attention",
      detail: "The campaign is verified, but this account's Relay number is not in its Messaging Service sender pool.",
    };
  }

  if (!evidence.numberSmsCapable) {
    return {
      profile: "needs_changes",
      a2p: "needs_attention",
      detail: "The campaign is verified, but Twilio does not report this account's Relay number as SMS capable.",
    };
  }

  return {
    profile: "approved",
    a2p: "approved",
    detail: "Twilio reports the campaign registered and this account's SMS-capable Relay number in its sender pool.",
  };
}
