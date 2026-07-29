export type VoicemailSummaryClassification =
  | "service_request"
  | "personal_call"
  | "vendor_notice"
  | "sales_call"
  | "wrong_number"
  | "spam"
  | "other"
  | "unknown";

export type StructuredVoicemailSummary = {
  classification: VoicemailSummaryClassification;
  summary: string;
  evidence: string[];
  urgency: "fast" | "today" | "normal";
  urgency_evidence: string;
};

export type ValidatedVoicemailSummary = Omit<StructuredVoicemailSummary, "summary"> & {
  summary: string | null;
};

const CLASSIFICATIONS = new Set<VoicemailSummaryClassification>([
  "service_request",
  "personal_call",
  "vendor_notice",
  "sales_call",
  "wrong_number",
  "spam",
  "other",
  "unknown",
]);

const URGENCY_LEVELS = new Set(["fast", "today", "normal"]);

const ALLOWED_SUMMARY_WORDS = new Set([
  "a", "about", "and", "ask", "asks", "asking", "back", "call", "callback", "caller",
  "calling", "from", "for", "follow", "is", "left", "message", "needs", "notice", "of",
  "personal", "request", "requests", "sales", "says", "service", "spam", "the", "to",
  "up", "vendor", "voicemail", "want", "wants", "wrong",
]);

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeEvidenceText(value: string) {
  return normalizeWhitespace(value)
    .toLocaleLowerCase("en-US")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'");
}

function lexicalWords(value: string) {
  return normalizeEvidenceText(value).match(/[\p{L}\p{N}']+/gu) ?? [];
}

function transcriptSupportsEvidence(transcript: string, evidence: string) {
  const normalizedEvidence = normalizeEvidenceText(evidence);
  return Boolean(normalizedEvidence) && normalizeEvidenceText(transcript).includes(normalizedEvidence);
}

function summaryIsLexicallyGrounded(transcript: string, summary: string) {
  const transcriptWords = new Set(lexicalWords(transcript));

  return lexicalWords(summary).every(
    (word) => transcriptWords.has(word) || ALLOWED_SUMMARY_WORDS.has(word),
  );
}

export function parseStructuredVoicemailSummary(value: string): StructuredVoicemailSummary | null {
  try {
    const parsed = JSON.parse(value) as Partial<StructuredVoicemailSummary>;

    if (
      !parsed ||
      typeof parsed.summary !== "string" ||
      !Array.isArray(parsed.evidence) ||
      !parsed.evidence.every((item) => typeof item === "string") ||
      !CLASSIFICATIONS.has(parsed.classification as VoicemailSummaryClassification) ||
      !URGENCY_LEVELS.has(parsed.urgency ?? "") ||
      typeof parsed.urgency_evidence !== "string"
    ) {
      return null;
    }

    return {
      classification: parsed.classification as VoicemailSummaryClassification,
      summary: normalizeWhitespace(parsed.summary).slice(0, 500),
      evidence: parsed.evidence.map(normalizeWhitespace).filter(Boolean).slice(0, 3),
      urgency: parsed.urgency as StructuredVoicemailSummary["urgency"],
      urgency_evidence: normalizeWhitespace(parsed.urgency_evidence),
    };
  } catch {
    return null;
  }
}

export function validateStructuredVoicemailSummary(
  transcript: string,
  candidate: StructuredVoicemailSummary,
): { result: ValidatedVoicemailSummary | null; reasons: string[] } {
  const reasons: string[] = [];
  const hasSummary = Boolean(candidate.summary);

  if (hasSummary && candidate.evidence.length === 0) {
    reasons.push("summary_missing_evidence");
  }

  if (candidate.evidence.some((evidence) => !transcriptSupportsEvidence(transcript, evidence))) {
    reasons.push("summary_evidence_not_in_transcript");
  }

  if (hasSummary && !summaryIsLexicallyGrounded(transcript, candidate.summary)) {
    reasons.push("summary_contains_unsupported_words");
  }

  if (
    candidate.urgency !== "normal" &&
    !transcriptSupportsEvidence(transcript, candidate.urgency_evidence)
  ) {
    reasons.push("urgency_missing_transcript_evidence");
  }

  if (candidate.urgency === "normal" && candidate.urgency_evidence) {
    reasons.push("normal_urgency_must_not_include_evidence");
  }

  if (reasons.length > 0) {
    return { result: null, reasons };
  }

  return {
    result: {
      ...candidate,
      summary: candidate.summary || null,
    },
    reasons: [],
  };
}

export const VOICEMAIL_SUMMARY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["classification", "summary", "evidence", "urgency", "urgency_evidence"],
  properties: {
    classification: {
      type: "string",
      enum: [
        "service_request",
        "personal_call",
        "vendor_notice",
        "sales_call",
        "wrong_number",
        "spam",
        "other",
        "unknown",
      ],
    },
    summary: { type: "string" },
    evidence: {
      type: "array",
      items: { type: "string" },
    },
    urgency: {
      type: "string",
      enum: ["fast", "today", "normal"],
    },
    urgency_evidence: { type: "string" },
  },
} as const;
