// One truthful owner-facing view of what Relay can do for an account right
// now. Calls, voicemail transcription, and automatic texting are independent
// facts; none of them may be inferred from another. Pure so the copy and
// gating are contract-testable without a database.

import type { A2pRegistrationStatus, TechnicalSetupStatus } from "@/lib/customer-experience-contract";

export type OwnerServiceStatusInput = {
  // Loosely typed on purpose: callers pass whatever the store returned, and an
  // unknown or missing value is treated as "still being set up", never as live.
  technicalStatus: TechnicalSetupStatus | string | null | undefined;
  a2pStatus: A2pRegistrationStatus | string | null | undefined;
  smsEnabled: boolean;
  voicemailTranscriptionEnabled: boolean;
  // Platform-level: transcription cannot run without a configured provider key.
  transcriptionProviderConfigured: boolean;
};

export type OwnerCapabilityTone = "ready" | "pending" | "attention" | "off";

export type OwnerCapability = {
  key: "calls" | "transcription" | "texting";
  title: string;
  label: string;
  tone: OwnerCapabilityTone;
  detail: string;
  // Who has to act for this capability to change. "none" means it's ready.
  owner: "none" | "you" | "relay";
  nextStep: string | null;
};

export type OwnerServiceStatus = {
  calls: OwnerCapability;
  transcription: OwnerCapability;
  texting: OwnerCapability;
  // Owners can text from Relay's number only when the account is allowed and
  // has chosen to. Mirrors the server-side reply gate exactly.
  canTextFromRelay: boolean;
  headline: string;
};

export function canTextFromRelayNumber(input: Pick<OwnerServiceStatusInput, "a2pStatus" | "smsEnabled">) {
  return input.a2pStatus === "approved" && input.smsEnabled;
}

export function deriveOwnerServiceStatus(input: OwnerServiceStatusInput): OwnerServiceStatus {
  const callsLive = input.technicalStatus === "live";
  const calls: OwnerCapability = callsLive
    ? {
        key: "calls",
        title: "Calls",
        label: "Live",
        tone: "ready",
        detail: "Relay answers the calls you miss and saves each one here.",
        owner: "none",
        nextStep: null,
      }
    : input.technicalStatus === "waiting_for_forwarding"
      ? {
          key: "calls",
          title: "Calls",
          label: "Action needed",
          tone: "attention",
          detail: "Relay is ready, but your number is not forwarding missed calls yet.",
          owner: "you",
          nextStep: "Turn on conditional forwarding using the steps on the Setup page.",
        }
      : input.technicalStatus === "paused" || input.technicalStatus === "closed"
        ? {
            key: "calls",
            title: "Calls",
            label: input.technicalStatus === "closed" ? "Closed" : "Paused",
            tone: "off",
            detail: "Relay is not answering missed calls for this account.",
            owner: "relay",
            nextStep: "Contact Relay if this is unexpected.",
          }
        : {
            key: "calls",
            title: "Calls",
            label: "Being set up",
            tone: "pending",
            detail: "Relay is connecting your line. Nothing is needed from you yet.",
            owner: "relay",
            nextStep: null,
          };

  const transcriptionOn = input.voicemailTranscriptionEnabled && input.transcriptionProviderConfigured;
  const transcription: OwnerCapability = transcriptionOn
    ? {
        key: "transcription",
        title: "Voicemail",
        label: "Transcribed",
        tone: "ready",
        detail: "Voicemails are transcribed and summarized when the caller leaves a clear message.",
        owner: "none",
        nextStep: null,
      }
    : {
        key: "transcription",
        title: "Voicemail",
        label: "Recording only",
        tone: "pending",
        detail: "Voicemails are saved so you can listen, but they are not transcribed right now.",
        owner: "relay",
        nextStep: "Relay is enabling transcription. Listen to recordings from each lead in the meantime.",
      };

  const textingOn = canTextFromRelayNumber(input);
  const a2pApproved = input.a2pStatus === "approved";
  const a2pAttention =
    input.a2pStatus === "rejected" || input.a2pStatus === "needs_attention" || input.a2pStatus === "paused";
  const texting: OwnerCapability = textingOn
    ? {
        key: "texting",
        title: "Texting",
        label: "On",
        tone: "ready",
        detail: "Missed callers get an automatic text, and you can reply from your Relay number.",
        owner: "none",
        nextStep: null,
      }
    : a2pApproved
      ? {
          key: "texting",
          title: "Texting",
          label: "Ready to turn on",
          tone: "attention",
          detail: "Carrier registration is approved. Automatic text-back stays off until you turn it on.",
          owner: "you",
          nextStep: "Turn on automatic text-back in Settings.",
        }
      : a2pAttention
        ? {
            key: "texting",
            title: "Texting",
            label: "Relay is resolving this",
            tone: "pending",
            detail: "Carrier registration needs work on Relay's side.",
            owner: "relay",
            nextStep: "Nothing is needed from you. Call back or text from your own phone in the meantime.",
          }
        : {
            key: "texting",
            title: "Texting",
            label: "Waiting on carrier registration",
            tone: "pending",
            detail: "Relay can't text from your Relay number until carriers approve the registration Relay is completing.",
            owner: "relay",
            nextStep: "Nothing is needed from you. Call back or text from your own phone in the meantime.",
          };

  const headline = !callsLive
    ? calls.label === "Action needed"
      ? "One step before Relay can catch missed calls"
      : calls.tone === "off"
        ? "Relay is not catching calls right now"
        : "Relay is getting your line ready"
    : textingOn
      ? "Relay is catching calls and texting callers back"
      : "Relay is catching calls. Texting from your Relay number is not on yet.";

  return {
    calls,
    transcription,
    texting,
    canTextFromRelay: textingOn,
    headline,
  };
}
