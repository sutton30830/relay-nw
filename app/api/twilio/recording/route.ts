import { after } from "next/server";
import { env } from "@/lib/env";
import { notifyAdminOperationalIssue } from "@/lib/email";
import {
  assertTenantAccount,
  logWebhookEvent,
  resolveAccountByCallSid,
  resolveAccountByTwilioNumber,
  resolveConsistentAccountEvidence,
  updateCallRecordingByCallSid,
  updateLeadRecordingByCallSid,
  updateLeadVoicemailTranscription,
  type TenantAccountRuntimeConfig,
  resolveAccountSafely,
} from "@/lib/supabase";
import {
  isExpectedVoicemailQualityErrorMessage,
  transcribeLeadVoicemail,
} from "@/lib/voicemail-ai";
import {
  formDataToRecord,
  phoneLast4,
  rejectInvalidTwilioSignature,
  summarizeTwilioRequest,
  validateTwilioWebhook,
} from "@/lib/twilio";
import { handleUnresolvedTwilioAccount } from "@/lib/twilio/unresolved-account";
import { emptyTwiml, twimlResponse } from "@/lib/twiml";
import { normalizePhoneNumber } from "@/lib/phone";
import { NO_USABLE_VOICEMAIL_MESSAGE, recordingIsTooShort } from "@/lib/voicemail-quality";

// Automatic voicemail transcription runs in after() within this function's lifetime.
// Without an explicit maxDuration, Vercel's default function timeout can kill the
// download + transcription + summary chain mid-flight, leaving summaries to only ever
// complete via manual retry (the stale-processing takeover).
export const runtime = "nodejs";
export const maxDuration = 120;

const RECORDING_WEBHOOK_SOURCE = "twilio_recording";

function parseDuration(value: string | null) {
  if (!value) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordingMediaUrl(value: string | null) {
  if (!value) return null;
  return value.endsWith(".mp3") || value.endsWith(".wav") ? value : `${value}.mp3`;
}

function parseRecordingPayload(payload: Record<string, string>) {
  return {
    callSid: (payload.CallSid ?? "").trim(),
    callerPhone: normalizePhoneNumber((payload.From ?? "").trim()),
    recordingSid: (payload.RecordingSid ?? "").trim() || null,
    recordingUrl: recordingMediaUrl((payload.RecordingUrl ?? "").trim() || null),
    recordingDuration: parseDuration((payload.RecordingDuration ?? "").trim() || null),
    recordingStatus: (payload.RecordingStatus ?? "").trim() || null,
  };
}

function webhookEventNote(input: {
  matchedUrl: string | null;
  recordingUpdated: boolean;
  recordingMatchedBy?: string | null;
  missingCallSid: boolean;
  unmatchedCallSid: boolean;
}) {
  const notes = [];

  if (input.matchedUrl) {
    notes.push(`Validated with URL: ${input.matchedUrl}`);
  } else if (env.allowUnsignedTwilioWebhooks) {
    notes.push("Unsigned/invalid Twilio recording webhook allowed by env override.");
  }

  if (input.recordingUpdated) {
    notes.push(
      input.recordingMatchedBy === "phone"
        ? "Recording attached to the latest recent lead from this caller."
        : "Recording attached to lead.",
    );
  }

  if (input.missingCallSid) {
    notes.push("Skipped recording update because CallSid was missing.");
  }

  if (input.unmatchedCallSid) {
    notes.push("No lead matched the recording CallSid.");
  }

  return notes.length > 0 ? notes.join(" ") : null;
}

async function updateLeadRecording(
  account: TenantAccountRuntimeConfig,
  input: ReturnType<typeof parseRecordingPayload>,
  correlationId: string,
) {
  if (!input.callSid) {
    console.warn("Skipping recording update because CallSid was missing", {
      correlationId,
      recordingSid: input.recordingSid,
      recordingStatus: input.recordingStatus,
    });

    return { updated: false, leadId: null, missingCallSid: true };
  }

  await updateCallRecordingByCallSid({
    accountId: account.accountId,
    ...input,
  });

  const result = await updateLeadRecordingByCallSid({
    accountId: account.accountId,
    ...input,
  });

  if (!result.updated) {
    console.warn("Recording webhook did not match an existing lead", {
      correlationId,
      callSid: input.callSid,
      recordingSid: input.recordingSid,
      recordingStatus: input.recordingStatus,
    });
  } else if (result.matchedBy === "phone") {
    console.info("Recording webhook matched a recent lead by caller phone fallback", {
      correlationId,
      callSid: input.callSid,
      callerLast4: phoneLast4(input.callerPhone),
      recordingSid: input.recordingSid,
    });
  }

  return {
    updated: result.updated,
    leadId: result.leadId,
    missingCallSid: false,
    matchedBy: result.matchedBy,
  };
}

function shouldAutoTranscribeRecording(input: ReturnType<typeof parseRecordingPayload>) {
  if (!input.recordingSid) {
    return false;
  }

  if (recordingIsTooShort(input.recordingDuration)) {
    return false;
  }

  return input.recordingStatus === "completed" || !input.recordingStatus;
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const payload = formDataToRecord(formData);
  const correlationId = payload.CallSid || payload.MessageSid || payload.RecordingSid || crypto.randomUUID();
  const requestSummary = summarizeTwilioRequest(request, payload);
  const validation = validateTwilioWebhook(request, payload);
  const recording = parseRecordingPayload(payload);
  const accountResolution = await resolveAccountSafely(async () => {
    const [byCallSid, byNumber] = await Promise.all([
      resolveAccountByCallSid(recording.callSid),
      resolveAccountByTwilioNumber(payload.To),
    ]);
    const resolution = resolveConsistentAccountEvidence([
      { label: "CallSid", resolution: byCallSid },
      { label: "To", resolution: byNumber },
    ]);

    if (byCallSid.status === "unresolved" && byNumber.status === "resolved") {
      console.warn("recording resolved by To-number fallback; calls row was missing", {
        correlationId,
        callSid: recording.callSid,
        recordingSid: recording.recordingSid,
      });
    }

    return resolution;
  }, "recording");
  const resolvedAccount = accountResolution.status === "resolved" ? accountResolution.account : null;
  const xml = emptyTwiml();

  console.info("Twilio recording webhook received", {
    correlationId,
    accountId: resolvedAccount?.accountId ?? null,
    accountSlug: resolvedAccount?.accountSlug ?? null,
    accountResolutionStatus: accountResolution.status,
    ...requestSummary,
    recordingSid: recording.recordingSid,
    recordingDuration: recording.recordingDuration,
    recordingStatus: recording.recordingStatus,
  });

  if (validation.shouldReject) {
    return rejectInvalidTwilioSignature({
      source: RECORDING_WEBHOOK_SOURCE,
      accountId: resolvedAccount?.accountId ?? null,
      label: "recording",
      payload,
      correlationId,
      requestSummary,
      candidateUrls: validation.candidateUrls,
      hasSignature: validation.hasSignature,
    });
  }

  if (accountResolution.status === "unresolved") {
    return handleUnresolvedTwilioAccount({
      resolution: accountResolution,
      source: RECORDING_WEBHOOK_SOURCE,
      label: "recording",
      payload,
      correlationId,
      responseBody: xml,
    });
  }

  const account = assertTenantAccount(accountResolution.account, "recording webhook");

  try {
    const result = await updateLeadRecording(account, recording, correlationId);

    if (result.leadId && recordingIsTooShort(recording.recordingDuration)) {
      await updateLeadVoicemailTranscription({
        accountId: account.accountId,
        id: result.leadId,
        rawTranscript: null,
        transcriptionModel: env.openaiTranscriptionModel,
        transcriptionConfidence: null,
        transcriptionQuality: "unavailable",
        transcriptionQualityReasons: ["recording_too_short"],
        transcriptionMetrics: null,
        transcript: null,
        summary: null,
        summaryClassification: null,
        summaryEvidence: null,
        summaryValidationReasons: null,
        status: "failed",
        error: NO_USABLE_VOICEMAIL_MESSAGE,
      });
    }

    if (account.voicemailTranscriptionEnabled && result.leadId && shouldAutoTranscribeRecording(recording)) {
      after(async () => {
        try {
          await transcribeLeadVoicemail(result.leadId!, account.accountId);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown voicemail transcription error";

          if (message === "Voicemail summary is already generating.") {
            console.info("Skipping duplicate automatic voicemail transcription", {
              correlationId,
              leadId: result.leadId,
              recordingSid: recording.recordingSid,
            });
            return;
          }

          if (isExpectedVoicemailQualityErrorMessage(message)) {
            console.info("Automatic voicemail transcription suppressed an uncertain result", {
              correlationId,
              leadId: result.leadId,
              recordingSid: recording.recordingSid,
              outcome: message,
            });
            return;
          }

          console.error("Automatic voicemail transcription failed", {
            correlationId,
            leadId: result.leadId,
            recordingSid: recording.recordingSid,
            error: message,
          });

          // Surface the failure in the webhook event log so it is visible from the inbox,
          // not only in server logs. The lead itself is marked failed inside
          // transcribeLeadVoicemail, so the UI shows "Summary unavailable".
          await logWebhookEvent({
            accountId: account.accountId,
            source: RECORDING_WEBHOOK_SOURCE,
            correlationId,
            payload,
            responseStatus: 200,
            responseBody: xml,
            error: `Automatic voicemail transcription failed for lead ${result.leadId}: ${message}`,
          });
        }
      });
    }

    await logWebhookEvent({
      accountId: account.accountId,
      source: RECORDING_WEBHOOK_SOURCE,
      correlationId,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: webhookEventNote({
        matchedUrl: validation.matchedUrl,
        recordingUpdated: result.updated,
        recordingMatchedBy: result.matchedBy,
        missingCallSid: result.missingCallSid,
        unmatchedCallSid: !result.updated && !result.missingCallSid,
      }),
    });

    if (!result.updated && !result.missingCallSid) {
      await notifyAdminOperationalIssue({
        account,
        issue: "Recording did not attach to a lead",
        detail: `CallSid ${recording.callSid || "missing"} RecordingSid ${recording.recordingSid || "missing"}`,
        correlationId,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown recording webhook error";

    await logWebhookEvent({
      accountId: account.accountId,
      source: RECORDING_WEBHOOK_SOURCE,
      correlationId,
      payload,
      responseStatus: 200,
      responseBody: xml,
      error: message,
    });

    console.error("Failed to handle Twilio recording webhook", {
      correlationId,
      ...requestSummary,
      error: message,
    });
    await notifyAdminOperationalIssue({
      account,
      issue: "Recording webhook failed",
      detail: message,
      correlationId,
    });
  }

  return twimlResponse(xml);
}
