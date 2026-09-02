// Owner-initiated correction of a wrong transcript. The owner heard the
// recording and knows better than the model; Relay hides the customer-facing
// transcript and summary, keeps the recording and the provider's raw output as
// evidence, resets the urgency that was derived from the bad text, and records
// the dispute so retries never overwrite a human decision.

import {
  getLeadForVoicemailTranscription,
  recordProviderAction,
  updateLeadPriority,
  updateLeadVoicemailTranscription,
} from "@/lib/supabase";
import { OWNER_DISPUTED_TRANSCRIPT_MESSAGE, isOwnerDisputedTranscript } from "@/lib/voicemail-quality";

export type VoicemailDisputeResult =
  | { outcome: "disputed" }
  | { outcome: "already_disputed" }
  | { outcome: "not_found" }
  | { outcome: "no_recording" };

export async function disputeLeadVoicemailTranscript(input: {
  leadId: string;
  accountId: string;
  actorEmail?: string | null;
}): Promise<VoicemailDisputeResult> {
  const lead = await getLeadForVoicemailTranscription(input.leadId, input.accountId);

  if (!lead) return { outcome: "not_found" };
  if (!lead.recording_sid) return { outcome: "no_recording" };

  // Idempotent: a second tap (or a retried request) changes nothing.
  if (
    lead.voicemail_transcription_status === "failed" &&
    !lead.voicemail_transcript &&
    !lead.voicemail_summary &&
    isOwnerDisputedTranscript(lead.voicemail_transcription_error)
  ) {
    return { outcome: "already_disputed" };
  }

  // Customer-facing text is cleared; voicemail_raw_transcript is deliberately
  // left untouched as diagnostic evidence.
  await updateLeadVoicemailTranscription({
    accountId: input.accountId,
    id: input.leadId,
    transcript: null,
    summary: null,
    summaryClassification: null,
    summaryEvidence: null,
    summaryValidationReasons: ["owner_disputed"],
    status: "failed",
    error: OWNER_DISPUTED_TRANSCRIPT_MESSAGE,
  });

  // Urgency was classified from text the owner just rejected.
  await updateLeadPriority({
    accountId: input.accountId,
    id: input.leadId,
    priority: "normal",
    priorityReason: null,
  });

  await recordProviderAction({
    accountId: input.accountId,
    action: "voicemail_transcription_disputed",
    provider: "relay",
    idempotencyKey: `voicemail_dispute:${input.leadId}`,
    providerIdentifier: lead.recording_sid,
    resourceType: "lead",
    resourceId: input.leadId,
    internalStatus: "suppressed",
    providerStatus: "owner_disputed",
    diagnosticDetail: {
      actorEmail: input.actorEmail ?? null,
      hadTranscript: Boolean(lead.voicemail_transcript),
      hadSummary: Boolean(lead.voicemail_summary),
    },
    customerExplanation: "You marked this transcript as wrong, so Relay hid it and kept the recording.",
    retryEligibility: "never",
    recommendedNextAction: "Listen to the recording. Relay will not re-transcribe it automatically.",
    customerVisible: false,
    expectedSuppression: true,
  });

  return { outcome: "disputed" };
}
