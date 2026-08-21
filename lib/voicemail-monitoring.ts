import { isExpectedQualitySuppression, type RetryEligibility } from "@/lib/provider-actions";

export type VoicemailLeadSignal = {
  id: string;
  phone: string | null;
  createdAt: string;
  recordingSid: string | null;
  recordingDuration: number | null;
  recordingStatus: string | null;
  transcriptionStatus: string | null;
  transcriptionError: string | null;
  transcriptionChangedAt: string | null;
  hasSummary: boolean;
  summaryValidationReasons: string[];
};

export type VoicemailActionSignal = {
  id: string;
  action: string;
  resourceId: string | null;
  internalStatus: string;
  providerStatus: string | null;
  retryEligibility: RetryEligibility;
  recommendedNextAction: string | null;
  suppressed: boolean;
  lastAttemptAt: string;
};

export type VoicemailPipelineIssue = {
  leadId: string;
  callerLast4: string | null;
  createdAt: string;
  stage: "recording" | "transcription" | "summary";
  state: "waiting" | "processing" | "stalled" | "failed";
  severity: "warning" | "critical";
  detail: string;
  retryEligibility: RetryEligibility;
  recommendedNextAction: string;
  lastChangedAt: string;
  providerActionId: string | null;
};

export type VoicemailPipelineHealth = {
  recordings: number;
  transcriptsReady: number;
  summariesReady: number;
  waiting: number;
  processing: number;
  stalled: number;
  failed: number;
  suppressed: number;
  issues: VoicemailPipelineIssue[];
};

const PROCESSING_STALE_MS = 10 * 60 * 1000;
const WAITING_GRACE_MS = 5 * 60 * 1000;
const RETRYABLE_SUMMARY_REASONS = new Set([
  "summary_contains_unsupported_words",
  "summary_request_failed",
]);

function ageMs(value: string, now: Date) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : 0;
}

function callerLast4(phone: string | null) {
  const digits = phone?.replace(/\D/g, "") ?? "";
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function latestAction(
  actions: VoicemailActionSignal[],
  leadId: string,
  action: string,
) {
  return actions
    .filter((candidate) => candidate.resourceId === leadId && candidate.action === action)
    .sort((a, b) => b.lastAttemptAt.localeCompare(a.lastAttemptAt))[0] ?? null;
}

function actionNextStep(action: VoicemailActionSignal | null, fallback: string) {
  return action?.recommendedNextAction?.trim() || fallback;
}

export function calculateVoicemailPipelineHealth(
  leads: VoicemailLeadSignal[],
  actions: VoicemailActionSignal[],
  now = new Date(),
): VoicemailPipelineHealth {
  const recordings = leads.filter((lead) => Boolean(lead.recordingSid));
  const issues: VoicemailPipelineIssue[] = [];
  let processing = 0;
  let suppressed = 0;

  for (const lead of recordings) {
    const transcriptionAction = latestAction(actions, lead.id, "voicemail_transcription");
    const summaryAction = latestAction(actions, lead.id, "voicemail_summary");
    const recordingAction = latestAction(actions, lead.id, "recording_retrieval");
    const changedAt = lead.transcriptionChangedAt ?? lead.createdAt;

    if (
      lead.recordingStatus === "failed" ||
      (recordingAction?.internalStatus === "failed" && !recordingAction.suppressed)
    ) {
      issues.push({
        leadId: lead.id,
        callerLast4: callerLast4(lead.phone),
        createdAt: lead.createdAt,
        stage: "recording",
        state: "failed",
        severity: "critical",
        detail: "Relay could not retrieve the stored voicemail recording.",
        retryEligibility: recordingAction?.retryEligibility ?? "manual",
        recommendedNextAction: actionNextStep(
          recordingAction,
          "Verify the Twilio recording SID before retrying retrieval.",
        ),
        lastChangedAt: recordingAction?.lastAttemptAt ?? changedAt,
        providerActionId: recordingAction?.id ?? null,
      });
      continue;
    }

    if (lead.transcriptionStatus === "processing") {
      if (ageMs(changedAt, now) > PROCESSING_STALE_MS) {
        issues.push({
          leadId: lead.id,
          callerLast4: callerLast4(lead.phone),
          createdAt: lead.createdAt,
          stage: summaryAction?.internalStatus === "processing" ? "summary" : "transcription",
          state: "stalled",
          severity: "critical",
          detail: "Processing exceeded the 10-minute stale-lock threshold.",
          retryEligibility: "automatic",
          recommendedNextAction: "Confirm the next transcription-retry run safely reclaimed this lead.",
          lastChangedAt: changedAt,
          providerActionId: summaryAction?.id ?? transcriptionAction?.id ?? null,
        });
      } else {
        processing += 1;
      }
      continue;
    }

    if (lead.transcriptionStatus === "pending" || lead.transcriptionStatus === null) {
      if (ageMs(lead.createdAt, now) > WAITING_GRACE_MS) {
        issues.push({
          leadId: lead.id,
          callerLast4: callerLast4(lead.phone),
          createdAt: lead.createdAt,
          stage: "transcription",
          state: "waiting",
          severity: "warning",
          detail: "A recorded voicemail has waited more than five minutes for transcription.",
          retryEligibility: "automatic",
          recommendedNextAction: "Confirm the retry job sees this eligible voicemail.",
          lastChangedAt: changedAt,
          providerActionId: transcriptionAction?.id ?? null,
        });
      } else {
        processing += 1;
      }
      continue;
    }

    if (lead.transcriptionStatus === "failed") {
      if (
        isExpectedQualitySuppression(lead.transcriptionError) ||
        transcriptionAction?.suppressed === true
      ) {
        suppressed += 1;
        continue;
      }

      issues.push({
        leadId: lead.id,
        callerLast4: callerLast4(lead.phone),
        createdAt: lead.createdAt,
        stage: "transcription",
        state: "failed",
        severity: "critical",
        detail: "The latest actionable transcription attempt failed.",
        retryEligibility: transcriptionAction?.retryEligibility ?? "automatic",
        recommendedNextAction: actionNextStep(
          transcriptionAction,
          "Use the atomic transcription retry after confirming the recording is available.",
        ),
        lastChangedAt: transcriptionAction?.lastAttemptAt ?? changedAt,
        providerActionId: transcriptionAction?.id ?? null,
      });
      continue;
    }

    if (lead.transcriptionStatus === "completed" && !lead.hasSummary) {
      const hasRetryableReason = lead.summaryValidationReasons.some((reason) =>
        RETRYABLE_SUMMARY_REASONS.has(reason),
      );
      const summaryFailed = summaryAction?.internalStatus === "failed" && !summaryAction.suppressed;

      if (hasRetryableReason || summaryFailed) {
        issues.push({
          leadId: lead.id,
          callerLast4: callerLast4(lead.phone),
          createdAt: lead.createdAt,
          stage: "summary",
          state: "failed",
          severity: "warning",
          detail: "The verified transcript is ready, but summary generation needs recovery.",
          retryEligibility: summaryAction?.retryEligibility ?? "automatic",
          recommendedNextAction: actionNextStep(
            summaryAction,
            "Regenerate only the summary from the verified transcript.",
          ),
          lastChangedAt: summaryAction?.lastAttemptAt ?? changedAt,
          providerActionId: summaryAction?.id ?? null,
        });
      } else {
        suppressed += 1;
      }
    }
  }

  issues.sort((a, b) => {
    const severity = { critical: 0, warning: 1 } as const;
    return severity[a.severity] - severity[b.severity] || b.lastChangedAt.localeCompare(a.lastChangedAt);
  });

  return {
    recordings: recordings.length,
    transcriptsReady: recordings.filter((lead) => lead.transcriptionStatus === "completed").length,
    summariesReady: recordings.filter((lead) => lead.hasSummary).length,
    waiting: issues.filter((issue) => issue.state === "waiting").length,
    processing,
    stalled: issues.filter((issue) => issue.state === "stalled").length,
    failed: issues.filter((issue) => issue.state === "failed").length,
    suppressed,
    issues: issues.slice(0, 5),
  };
}
