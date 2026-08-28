import { env } from "@/lib/env";
import { classifyPriority, type PriorityClassification } from "@/lib/priority";
import {
  assessTranscriptionConfidence,
  transcriptsMateriallyDisagree,
  transcriptWordErrorRate,
  type TranscriptionLogprob,
} from "@/lib/voicemail-confidence";
import {
  parseStructuredVoicemailSummary,
  validateStructuredVoicemailSummary,
  VOICEMAIL_SUMMARY_JSON_SCHEMA,
  type ValidatedVoicemailSummary,
} from "@/lib/voicemail-summary";
import {
  claimVoicemailSummary,
  claimVoicemailTranscription,
  getAccountConfigByAccountId,
  getLeadForVoicemailTranscription,
  recordProviderAction,
  updateLeadPriority,
  updateLeadVoicemailTranscription,
  type AccountRuntimeConfig,
} from "@/lib/supabase";
import { sendOwnerSms } from "@/lib/twilio";
import { getTelephonyProvider } from "@/lib/telephony/registry";
import { notifyAdminOperationalIssue, notifyOwnerVoicemailReady } from "@/lib/email";
import {
  NO_SPEECH_VOICEMAIL_MESSAGE,
  NO_USABLE_VOICEMAIL_MESSAGE,
  recordingIsTooShort,
  transcriptLooksLikeSilenceHallucination,
} from "@/lib/voicemail-quality";

type OpenAITranscriptionResponse = {
  text?: string;
  logprobs?: TranscriptionLogprob[];
};

type AudioTranscription = {
  model: string;
  rawTranscript?: string;
  transcript: string;
  logprobs: TranscriptionLogprob[];
};

type OpenAIResponsesResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
    }>;
  }>;
};

const STALE_PROCESSING_MS = 10 * 60 * 1000;
const OPENAI_TRANSCRIPTION_TIMEOUT_MS = 60_000;
const OPENAI_SUMMARY_TIMEOUT_MS = 30_000;
const RECOMMENDED_TRANSCRIPTION_MODEL = "gpt-transcribe";
const FULL_QUALITY_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const ADJUDICATION_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const LOGPROB_TRANSCRIPTION_MODELS = new Set([
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "gpt-4o-mini-transcribe-2025-12-15",
]);
const VOICEMAIL_TRANSCRIPTION_PROMPT =
  "A caller is leaving a voicemail after a missed phone call. The message may be personal, a test, a vendor notice, or a service request. Preserve exactly what is audible, including names, stated problems, and callback requests. Do not add words that were not spoken.";
const UNCERTAIN_TRANSCRIPTION_MESSAGE =
  "Relay could not confidently transcribe this voicemail. Listen to the recording instead.";

class ExpectedVoicemailQualityError extends Error {
  constructor(
    message: string,
    readonly qualityReason?: string,
  ) {
    super(message);
    this.name = "ExpectedVoicemailQualityError";
  }
}

export function isExpectedVoicemailQualityErrorMessage(message: string) {
  return (
    message === NO_USABLE_VOICEMAIL_MESSAGE ||
    message === NO_SPEECH_VOICEMAIL_MESSAGE ||
    message === UNCERTAIN_TRANSCRIPTION_MESSAGE
  );
}

async function fetchRecordingAudio(recordingSid: string) {
  const provider = getTelephonyProvider();
  const recording = await provider.fetchRecordingAudio({
    provider: provider.identity.id,
    kind: "recording",
    value: recordingSid,
  });
  return recording.audio;
}

function modelSupportsLogprobs(model: string) {
  return LOGPROB_TRANSCRIPTION_MODELS.has(model);
}

function verificationModelFor(primaryModel: string) {
  return primaryModel === RECOMMENDED_TRANSCRIPTION_MODEL
    ? FULL_QUALITY_TRANSCRIPTION_MODEL
    : RECOMMENDED_TRANSCRIPTION_MODEL;
}

function adjudicationModelFor(primaryModel: string, verificationModel: string) {
  if (
    primaryModel !== ADJUDICATION_TRANSCRIPTION_MODEL &&
    verificationModel !== ADJUDICATION_TRANSCRIPTION_MODEL
  ) {
    return ADJUDICATION_TRANSCRIPTION_MODEL;
  }

  return FULL_QUALITY_TRANSCRIPTION_MODEL;
}

async function transcribeAudio(audio: Blob, model: string): Promise<AudioTranscription> {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const form = new FormData();
  form.append("file", audio, "voicemail.mp3");
  form.append("model", model);
  form.append("response_format", "json");
  form.append("prompt", VOICEMAIL_TRANSCRIPTION_PROMPT);
  form.append("chunking_strategy", "auto");
  if (model === RECOMMENDED_TRANSCRIPTION_MODEL) {
    form.append("languages[]", "en");
  } else {
    form.append("language", "en");
  }
  form.append("temperature", "0");
  if (modelSupportsLogprobs(model)) {
    form.append("include[]", "logprobs");
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
    },
    body: form,
    signal: AbortSignal.timeout(OPENAI_TRANSCRIPTION_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(await openAIError("OpenAI transcription", response));
  }

  const data = await response.json() as OpenAITranscriptionResponse;
  const rawTranscript = data.text;
  const transcript = rawTranscript?.trim();

  return {
    model,
    rawTranscript,
    transcript: transcript ?? "",
    logprobs: data.logprobs ?? [],
  };
}

function candidateIsUsable(
  candidate: AudioTranscription,
  duration: number | null | undefined,
) {
  return Boolean(candidate.transcript) &&
    !transcriptLooksLikeSilenceHallucination(candidate.transcript, duration);
}

function reliableConfidenceSource(...candidates: AudioTranscription[]) {
  return candidates.find(
    (candidate) => assessTranscriptionConfidence(candidate.logprobs).quality === "reliable",
  ) ?? null;
}

async function selectReliableTranscript(input: {
  audio: Blob;
  primary: AudioTranscription;
  verification: AudioTranscription;
  recordingDuration: number | null | undefined;
}) {
  const primaryVerificationRate = transcriptWordErrorRate(
    input.primary.transcript,
    input.verification.transcript,
  );
  const primaryAndVerificationAgree = !transcriptsMateriallyDisagree(
    input.primary.transcript,
    input.verification.transcript,
  );

  if (primaryAndVerificationAgree) {
    return {
      selected: input.primary,
      confidenceSource: reliableConfidenceSource(input.primary, input.verification),
      verification: input.verification,
      adjudication: null,
      initialDisagreement: false,
      recoveredByAdjudication: false,
      metrics: {
        verification_word_error_rate: primaryVerificationRate,
        adjudication_primary_word_error_rate: null,
        adjudication_verification_word_error_rate: null,
        transcription_passes: 2,
      },
    };
  }

  const adjudicationModel = adjudicationModelFor(
    input.primary.model,
    input.verification.model,
  );
  const adjudication = await transcribeAudio(input.audio, adjudicationModel);
  const adjudicationPrimaryRate = transcriptWordErrorRate(
    input.primary.transcript,
    adjudication.transcript,
  );
  const adjudicationVerificationRate = transcriptWordErrorRate(
    input.verification.transcript,
    adjudication.transcript,
  );
  const adjudicationUsable = candidateIsUsable(adjudication, input.recordingDuration);
  const primarySupported =
    adjudicationUsable &&
    candidateIsUsable(input.primary, input.recordingDuration) &&
    !transcriptsMateriallyDisagree(input.primary.transcript, adjudication.transcript);
  const verificationSupported =
    adjudicationUsable &&
    candidateIsUsable(input.verification, input.recordingDuration) &&
    !transcriptsMateriallyDisagree(input.verification.transcript, adjudication.transcript);
  const selected = primarySupported && !verificationSupported
    ? input.primary
    : verificationSupported && !primarySupported
      ? input.verification
      : primarySupported && verificationSupported
        ? input.primary
        : null;
  const confidenceSource = selected
    ? reliableConfidenceSource(selected, adjudication)
    : reliableConfidenceSource(input.primary, input.verification, adjudication);

  return {
    selected,
    confidenceSource,
    verification: input.verification,
    adjudication,
    initialDisagreement: true,
    recoveredByAdjudication: Boolean(selected && confidenceSource),
    metrics: {
      verification_word_error_rate: primaryVerificationRate,
      adjudication_primary_word_error_rate: adjudicationPrimaryRate,
      adjudication_verification_word_error_rate: adjudicationVerificationRate,
      transcription_passes: 3,
    },
  };
}

async function summarizeTranscript(transcript: string): Promise<{
  summary: ValidatedVoicemailSummary | null;
  validationReasons: string[];
}> {
  if (!env.openaiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.openaiSummaryModel,
      max_output_tokens: 300,
      text: {
        format: {
          type: "json_schema",
          name: "voicemail_summary",
          strict: true,
          schema: VOICEMAIL_SUMMARY_JSON_SCHEMA,
        },
      },
      input: [
        {
          role: "system",
          content:
            "Extract a short, factual voicemail summary. Make the summary extractive: reuse the transcript's exact wording for names, companies, problems, objects, places, dates, timing, urgency, and other content words; add only minimal grammar. Preserve both why the caller called and what action they requested; do not output only a generic callback request when nearby transcript context explains the purpose. Copy 1-3 exact transcript excerpts into evidence. Every specific claim in the summary must be supported by those exact excerpts. Never infer a service request from context. A message can be a test call and still contain a real request: if the caller explicitly states a need or problem, summarize that need and do not let test-call language override it. Use classification unknown, an empty summary, and empty evidence only when the transcript does not support any useful summary. urgency must be normal with empty urgency_evidence unless the transcript explicitly supports fast or today; urgency_evidence must be an exact transcript excerpt.",
        },
        {
          role: "user",
          content: transcript.slice(0, 4000),
        },
      ],
    }),
    signal: AbortSignal.timeout(OPENAI_SUMMARY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(await openAIError("OpenAI summary", response));
  }

  const data = await response.json() as OpenAIResponsesResponse;
  const output = extractResponseText(data);

  if (!output) {
    throw new Error("OpenAI summary returned no text.");
  }

  const candidate = parseStructuredVoicemailSummary(output);

  if (!candidate) {
    return { summary: null, validationReasons: ["invalid_structured_summary"] };
  }

  const validation = validateStructuredVoicemailSummary(transcript, candidate);
  return {
    summary: validation.result,
    validationReasons: validation.reasons,
  };
}

function classifyVoicemailPriority(
  transcript: string,
  summary: ValidatedVoicemailSummary | null,
): PriorityClassification {
  const regexResult = classifyPriority(transcript);

  if (regexResult.level !== "normal" || !summary || summary.urgency === "normal") {
    return regexResult;
  }

  return {
    level: summary.urgency,
    reason: summary.urgency_evidence.slice(0, 120),
  };
}

async function openAIError(label: string, response: Response) {
  const body = await response.text();
  const detail = body ? ` ${body.slice(0, 500)}` : "";

  return `${label} failed with ${response.status}.${detail}`;
}

function extractResponseText(data: OpenAIResponsesResponse) {
  const directText = data.output_text?.trim();

  if (directText) {
    return directText;
  }

  return data.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .find((text) => text?.trim())
    ?.trim();
}

async function safelyRecordVoicemailAction(
  input: Parameters<typeof recordProviderAction>[0],
) {
  if (typeof recordProviderAction !== "function") return;
  try {
    await recordProviderAction(input);
  } catch (error) {
    console.error("Could not record voicemail provider action evidence", {
      accountId: input.accountId,
      resourceId: input.resourceId,
      action: input.action,
      error: error instanceof Error ? error.message : error,
    });
  }
}

async function notifyOwnerVoicemailByPush(input: {
  account: Pick<AccountRuntimeConfig, "accountId" | "businessName">;
  leadId: string;
  callerPhone: string | null;
}) {
  try {
    const { notifyOwnerByWebPush } = await import("@/lib/web-push");
    return await notifyOwnerByWebPush({
      account: input.account,
      event: "voicemail_ready",
      leadId: input.leadId,
      callerPhone: input.callerPhone,
    });
  } catch (error) {
    console.error("Voicemail Web Push notification could not start", {
      accountId: input.account.accountId,
      leadId: input.leadId,
      error: error instanceof Error ? error.message : error,
    });
    return { attempted: 0, delivered: 0, disabled: 0 };
  }
}

async function regenerateVoicemailSummary(input: {
  leadId: string;
  accountId: string;
  transcript: string;
}) {
  const claimed = await claimVoicemailSummary({
    accountId: input.accountId,
    id: input.leadId,
  });

  if (!claimed) {
    throw new Error("Voicemail summary is already generating.");
  }

  const actionKey = `voicemail_summary_recovery:${input.leadId}`;
  await safelyRecordVoicemailAction({
    accountId: input.accountId,
    action: "voicemail_summary",
    provider: "openai",
    idempotencyKey: actionKey,
    resourceType: "lead",
    resourceId: input.leadId,
    internalStatus: "processing",
    providerStatus: "summary_only_retry",
    customerExplanation: "Relay is regenerating the summary from the verified transcript.",
    retryEligibility: "automatic",
    recommendedNextAction: "Wait for the summary-only retry to finish.",
    customerVisible: false,
    countAttempt: true,
  });

  try {
    const summaryResult = await summarizeTranscript(input.transcript);
    const structuredSummary = summaryResult.summary;
    const summary = structuredSummary?.summary ?? null;

    await updateLeadVoicemailTranscription({
      accountId: input.accountId,
      id: input.leadId,
      transcript: input.transcript,
      summary,
      summaryClassification: structuredSummary?.classification ?? null,
      summaryEvidence: structuredSummary?.evidence ?? null,
      summaryValidationReasons: summaryResult.validationReasons,
      status: "completed",
      error: null,
    });

    await safelyRecordVoicemailAction({
      accountId: input.accountId,
      action: "voicemail_summary",
      provider: "openai",
      idempotencyKey: actionKey,
      resourceType: "lead",
      resourceId: input.leadId,
      internalStatus: "succeeded",
      providerStatus: structuredSummary ? "validated" : "quality_suppressed",
      customerExplanation: structuredSummary
        ? "Relay regenerated a grounded voicemail summary from the verified transcript."
        : "Relay kept the verified transcript but suppressed an unsupported summary.",
      retryEligibility: "never",
      recommendedNextAction: "Use the verified transcript as the source of truth.",
      customerVisible: false,
      expectedSuppression: !structuredSummary,
    });

    return {
      transcript: input.transcript,
      summary,
      status: "completed" as const,
    };
  } catch (error) {
    await updateLeadVoicemailTranscription({
      accountId: input.accountId,
      id: input.leadId,
      transcript: input.transcript,
      summaryValidationReasons: ["summary_request_failed"],
      status: "completed",
      error: null,
    });
    await safelyRecordVoicemailAction({
      accountId: input.accountId,
      action: "voicemail_summary",
      provider: "openai",
      idempotencyKey: actionKey,
      resourceType: "lead",
      resourceId: input.leadId,
      internalStatus: "failed",
      providerStatus: "summary_request_failed",
      diagnosticDetail: error,
      customerExplanation: "The verified transcript is available, but summary regeneration failed.",
      retryEligibility: "automatic",
      recommendedNextAction: "Retry summary generation from the existing transcript.",
      customerVisible: true,
    });
    throw error;
  }
}

export async function transcribeLeadVoicemail(
  leadId: string,
  accountId: string,
  options: { notifyOwner?: boolean } = {},
) {
  const lead = await getLeadForVoicemailTranscription(leadId, accountId);
  const transcriptionActionKey = `voicemail_transcription:${leadId}`;

  if (!lead?.recording_sid) {
    throw new Error("Lead does not have a voicemail recording.");
  }

  if (recordingIsTooShort(lead.recording_duration)) {
    await updateLeadVoicemailTranscription({
      accountId,
      id: leadId,
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
    await safelyRecordVoicemailAction({
        accountId,
        action: "voicemail_transcription",
        provider: "openai",
        idempotencyKey: transcriptionActionKey,
        providerIdentifier: lead.recording_sid,
        resourceType: "lead",
        resourceId: leadId,
        internalStatus: "suppressed",
        providerStatus: "recording_too_short",
        diagnosticDetail: "recording_too_short",
        customerVisible: false,
        expectedSuppression: true,
    });
    throw new Error(NO_USABLE_VOICEMAIL_MESSAGE);
  }

  if (lead.voicemail_summary && lead.voicemail_transcript) {
    // Legacy failures can contain fully persisted customer-facing evidence but
    // still carry a failed status from a later notification/encoding step. A
    // recovery must repair that status instead of returning cached content and
    // leaving Monitoring to surface the same lead forever.
    if (lead.voicemail_transcription_status !== "completed") {
      await updateLeadVoicemailTranscription({
        accountId,
        id: leadId,
        transcript: lead.voicemail_transcript,
        summary: lead.voicemail_summary,
        status: "completed",
        error: null,
      });
    }

    return {
      transcript: lead.voicemail_transcript,
      summary: lead.voicemail_summary,
      status: "completed" as const,
    };
  }

  if (lead.voicemail_transcript) {
    return regenerateVoicemailSummary({
      leadId,
      accountId,
      transcript: lead.voicemail_transcript,
    });
  }

  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
  const claimed = await claimVoicemailTranscription({ accountId, id: leadId, staleBefore });

  if (!claimed) {
    throw new Error("Voicemail summary is already generating.");
  }

  await safelyRecordVoicemailAction({
      accountId,
      action: "voicemail_transcription",
      provider: "openai",
      idempotencyKey: transcriptionActionKey,
      providerIdentifier: lead.recording_sid,
      resourceType: "lead",
      resourceId: leadId,
      internalStatus: "processing",
      providerStatus: "processing",
      customerExplanation: "Relay is transcribing this voicemail.",
      retryEligibility: "automatic",
      recommendedNextAction: "Wait for transcription or the stale-lock recovery job.",
      customerVisible: false,
      countAttempt: true,
  });

  try {
    const audio = await fetchRecordingAudio(lead.recording_sid);
    const verificationModel = verificationModelFor(env.openaiTranscriptionModel);
    const [transcription, verification] = await Promise.all([
      transcribeAudio(audio, env.openaiTranscriptionModel),
      transcribeAudio(audio, verificationModel),
    ]);

    const consensus = await selectReliableTranscript({
      audio,
      primary: transcription,
      verification,
      recordingDuration: lead.recording_duration,
    });

    // Two independent empty responses mean the models did not detect usable
    // speech. Repeating the same request does not recover silence, so classify
    // this as an expected quality suppression instead of a provider outage.
    if (!transcription.transcript && !verification.transcript) {
      throw new ExpectedVoicemailQualityError(
        NO_SPEECH_VOICEMAIL_MESSAGE,
        "no_speech_detected",
      );
    }
    const selectedTranscription = consensus.selected;
    const confidenceAssessment = assessTranscriptionConfidence(
      consensus.confidenceSource?.logprobs,
    );
    const qualityReasons = [...confidenceAssessment.reasons];
    const knownHallucination = transcriptLooksLikeSilenceHallucination(
      selectedTranscription?.transcript ?? transcription.transcript,
      lead.recording_duration,
    );

    if (knownHallucination) {
      qualityReasons.push("known_hallucination_pattern");
    }

    if (consensus.initialDisagreement) {
      qualityReasons.push("transcription_models_disagree");
    }

    if (consensus.recoveredByAdjudication) {
      qualityReasons.push("transcription_adjudication_recovered");
    } else if (consensus.initialDisagreement) {
      qualityReasons.push("transcription_adjudication_failed");
    }

    const quality =
      selectedTranscription && confidenceAssessment.quality === "reliable" && !knownHallucination
        ? "reliable"
        : confidenceAssessment.quality === "unavailable" || knownHallucination
          ? "unavailable"
          : "review_recommended";
    const transcriptionMetrics = {
      ...confidenceAssessment.metrics,
      verification_word_error_rate:
        Math.round(consensus.metrics.verification_word_error_rate * 10_000) / 10_000,
      adjudication_primary_word_error_rate:
        consensus.metrics.adjudication_primary_word_error_rate === null
          ? null
          : Math.round(consensus.metrics.adjudication_primary_word_error_rate * 10_000) / 10_000,
      adjudication_verification_word_error_rate:
        consensus.metrics.adjudication_verification_word_error_rate === null
          ? null
          : Math.round(consensus.metrics.adjudication_verification_word_error_rate * 10_000) / 10_000,
      transcription_passes: consensus.metrics.transcription_passes,
    };

    // Persist the provider's exact output before validating or transforming
    // anything. Even a rejected hallucination is useful diagnostic evidence.
    await updateLeadVoicemailTranscription({
      accountId,
      id: leadId,
      rawTranscript: selectedTranscription?.rawTranscript ?? transcription.rawTranscript,
      transcriptionModel: selectedTranscription?.model ?? env.openaiTranscriptionModel,
      transcriptionConfidence: confidenceAssessment.confidence,
      transcriptionQuality: quality,
      transcriptionQualityReasons: qualityReasons,
      transcriptionMetrics,
      transcript: null,
      summary: null,
      summaryClassification: null,
      summaryEvidence: null,
      summaryValidationReasons: null,
      status: "processing",
      error: null,
    });

    if (quality !== "reliable") {
      const message = knownHallucination
        ? NO_USABLE_VOICEMAIL_MESSAGE
        : UNCERTAIN_TRANSCRIPTION_MESSAGE;

      await updateLeadVoicemailTranscription({
        accountId,
        id: leadId,
        status: "failed",
        error: message,
      });
      throw new ExpectedVoicemailQualityError(message);
    }

    // The customer-facing transcript is only whitespace-normalized. It is not
    // sent through an LLM rewrite or an industry-specific substitution list.
    await updateLeadVoicemailTranscription({
      accountId,
      id: leadId,
      transcript: selectedTranscription?.transcript ?? transcription.transcript,
      transcriptionQuality: "reliable",
      status: "processing",
      error: null,
    });

    const transcript = selectedTranscription?.transcript ?? transcription.transcript;
    let structuredSummary: ValidatedVoicemailSummary | null = null;
    let summaryValidationReasons: string[] = [];

    try {
      const summaryResult = await summarizeTranscript(transcript);
      structuredSummary = summaryResult.summary;
      summaryValidationReasons = summaryResult.validationReasons;
    } catch (error) {
      summaryValidationReasons = ["summary_request_failed"];
      console.warn("Structured voicemail summary failed; keeping reliable transcript", {
        leadId,
        accountId,
        error: error instanceof Error ? error.message : error,
      });
      await safelyRecordVoicemailAction({
          accountId,
          action: "voicemail_summary",
          provider: "openai",
          idempotencyKey: `voicemail_summary:${leadId}`,
          resourceType: "lead",
          resourceId: leadId,
          internalStatus: "failed",
          providerStatus: "summary_request_failed",
          diagnosticDetail: error,
          customerExplanation: "The voicemail transcript is ready, but the short summary is temporarily unavailable.",
          retryEligibility: "automatic",
          recommendedNextAction: "Use the transcript now; Relay may safely regenerate only the summary.",
          customerVisible: true,
          countAttempt: true,
      });
    }

    const summary = structuredSummary?.summary ?? null;

    await updateLeadVoicemailTranscription({
      accountId,
      id: leadId,
      rawTranscript: selectedTranscription?.rawTranscript ?? transcription.rawTranscript,
      transcriptionModel: selectedTranscription?.model ?? env.openaiTranscriptionModel,
      transcriptionConfidence: confidenceAssessment.confidence,
      transcriptionQuality: "reliable",
      transcriptionQualityReasons: qualityReasons,
      transcriptionMetrics,
      transcript,
      summary,
      summaryClassification: structuredSummary?.classification ?? null,
      summaryEvidence: structuredSummary?.evidence ?? null,
      summaryValidationReasons,
      status: "completed",
      error: null,
    });

    await safelyRecordVoicemailAction({
        accountId,
        action: "voicemail_transcription",
        provider: "openai",
        idempotencyKey: transcriptionActionKey,
        providerIdentifier: lead.recording_sid,
        resourceType: "lead",
        resourceId: leadId,
        internalStatus: "succeeded",
        providerStatus: "completed",
        customerExplanation: "The voicemail transcript is ready.",
        retryEligibility: "never",
        recommendedNextAction: "Review the transcript and contact the caller.",
        customerVisible: false,
    });
      if (summaryValidationReasons[0] !== "summary_request_failed") {
        await safelyRecordVoicemailAction({
          accountId,
          action: "voicemail_summary",
          provider: "openai",
          idempotencyKey: `voicemail_summary:${leadId}`,
          resourceType: "lead",
          resourceId: leadId,
          internalStatus: "succeeded",
          providerStatus: structuredSummary ? "validated" : "quality_suppressed",
          customerExplanation: structuredSummary
            ? "The voicemail summary passed evidence validation."
            : "Relay kept the reliable transcript but suppressed an unsupported summary.",
          retryEligibility: "never",
          recommendedNextAction: "Use the transcript as the source of truth.",
          customerVisible: false,
          expectedSuppression: !structuredSummary,
        });
      }

    // Classify urgency from what the caller actually said, persist it, and escalate
    // fast-priority voicemails to the owner by SMS immediately. Never fatal: the
    // transcription result stands even if classification or notification fails.
    const classification = classifyVoicemailPriority(transcript, structuredSummary);

    try {
      await updateLeadPriority({
        accountId,
        id: leadId,
        priority: classification.level,
        priorityReason: classification.reason,
      });
    } catch (error) {
      console.error("Could not persist lead priority", {
        leadId,
        accountId,
        error: error instanceof Error ? error.message : error,
      });
    }

    const account = options.notifyOwner === false
      ? null
      : await getAccountConfigByAccountId(accountId);
    if (account) {
      const ownerSummary = summary ?? transcript.slice(0, 160);
      const voicemailSmsEnabled =
        account.notificationPreferences?.voicemailReady.sms ?? false;
      const urgentVoicemailSmsEnabled =
        account.notificationPreferences?.urgentVoicemailSms ?? true;
      const shouldTextOwner =
        voicemailSmsEnabled ||
        (classification.level === "fast" && urgentVoicemailSmsEnabled);

      if (shouldTextOwner) {
        const isUrgent = classification.level === "fast";
        await sendOwnerSms({
          account,
          context: isUrgent ? "urgent voicemail alert" : "voicemail ready alert",
          actionKey: isUrgent
            ? `owner_sms:urgent_voicemail:${leadId}`
            : `owner_sms:voicemail_ready:${leadId}`,
          body: isUrgent
            ? `Relay NW URGENT: voicemail from ${lead.phone} — ${classification.reason}. "${ownerSummary.slice(0, 160)}" Call back now or reply from your inbox: ${env.appBaseUrl}/leads`
            : `Relay NW: voicemail from ${lead.phone} — "${ownerSummary.slice(0, 180)}" Open your inbox: ${env.appBaseUrl}/leads`,
        });
      }

      await Promise.all([
        notifyOwnerVoicemailReady({
          account,
          leadId,
          callerPhone: lead.phone,
          summary: ownerSummary,
        }),
        notifyOwnerVoicemailByPush({
          account,
          leadId,
          callerPhone: lead.phone,
        }),
      ]);
    }

    return {
      transcript,
      summary,
      status: "completed" as const,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Voicemail transcription failed.";
    const qualityReason = error instanceof ExpectedVoicemailQualityError
      ? error.qualityReason
      : undefined;

    // Marking the lead "failed" is what makes the UI show "Summary unavailable. Listen
    // to the voicemail." If this update itself fails, don't mask the original error;
    // the stale-processing takeover above will recover the lead on the next attempt.
    try {
      await updateLeadVoicemailTranscription({
        accountId,
        id: leadId,
        ...(qualityReason ? {
          rawTranscript: null,
          transcriptionModel: env.openaiTranscriptionModel,
          transcriptionConfidence: null,
          transcriptionQuality: "unavailable" as const,
          transcriptionQualityReasons: [qualityReason],
          transcriptionMetrics: null,
          transcript: null,
          summary: null,
          summaryClassification: null,
          summaryEvidence: null,
          summaryValidationReasons: null,
        } : {}),
        status: "failed",
        error: message,
      });
    } catch (updateError) {
      console.error("Could not mark voicemail transcription as failed; lead may show as processing until stale takeover", {
        leadId,
        accountId,
        error: updateError instanceof Error ? updateError.message : updateError,
      });
    }

    if (
      !(error instanceof ExpectedVoicemailQualityError) &&
      !isExpectedVoicemailQualityErrorMessage(message)
    ) {
      const account = await getAccountConfigByAccountId(accountId);
      await notifyAdminOperationalIssue({
        account,
        issue: "Voicemail transcription failed",
        detail: message,
      });
    }

    if (typeof recordProviderAction === "function") {
      try {
        const expectedSuppression = error instanceof ExpectedVoicemailQualityError
          || isExpectedVoicemailQualityErrorMessage(message);
        await recordProviderAction({
          accountId,
          action: "voicemail_transcription",
          provider: "openai",
          idempotencyKey: transcriptionActionKey,
          providerIdentifier: lead.recording_sid,
          resourceType: "lead",
          resourceId: leadId,
          internalStatus: expectedSuppression ? "suppressed" : "failed",
          providerStatus: expectedSuppression ? "quality_suppressed" : "provider_failed",
          diagnosticDetail: message,
          customerVisible: !expectedSuppression,
          expectedSuppression,
        });
      } catch (recordError) {
        console.error("Could not record voicemail provider action failure", {
          accountId,
          leadId,
          error: recordError instanceof Error ? recordError.message : recordError,
        });
      }
    }

    throw error;
  }
}
