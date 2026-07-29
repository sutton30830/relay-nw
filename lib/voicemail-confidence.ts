import confidenceConfig from "./voicemail-confidence-config.json";

export type TranscriptionQuality = "reliable" | "review_recommended" | "unavailable";

export type TranscriptionLogprob = {
  token?: string;
  logprob?: number;
};

export type TranscriptionConfidenceAssessment = {
  confidence: number | null;
  quality: TranscriptionQuality;
  reasons: string[];
  metrics: {
    average_logprob: number | null;
    minimum_logprob: number | null;
    low_confidence_token_fraction: number | null;
    token_count: number;
  };
};

function lexicalLogprobs(logprobs: TranscriptionLogprob[]) {
  return logprobs
    .filter((item) => typeof item.logprob === "number" && Number.isFinite(item.logprob))
    .filter((item) => /[\p{L}\p{N}]/u.test(item.token ?? ""))
    .map((item) => item.logprob as number);
}

function roundMetric(value: number) {
  return Math.round(value * 10_000) / 10_000;
}

export function assessTranscriptionConfidence(
  logprobs: TranscriptionLogprob[] | null | undefined,
): TranscriptionConfidenceAssessment {
  const values = lexicalLogprobs(logprobs ?? []);

  if (values.length === 0) {
    return {
      confidence: null,
      quality: "unavailable",
      reasons: ["missing_logprobs"],
      metrics: {
        average_logprob: null,
        minimum_logprob: null,
        low_confidence_token_fraction: null,
        token_count: 0,
      },
    };
  }

  const averageLogprob = values.reduce((sum, value) => sum + value, 0) / values.length;
  const minimumLogprob = Math.min(...values);
  const lowTokenCount = values.filter((value) => value < confidenceConfig.lowLogprobThreshold).length;
  const lowTokenFraction = lowTokenCount / values.length;
  const confidence = Math.min(1, Math.max(0, Math.exp(averageLogprob)));
  const reasons: string[] = [];

  if (confidence < confidenceConfig.minimumReliableConfidence) {
    reasons.push("average_confidence_below_reliable_threshold");
  }

  if (lowTokenFraction > confidenceConfig.maximumReliableLowTokenFraction) {
    reasons.push("too_many_low_confidence_tokens");
  }

  if (minimumLogprob < confidenceConfig.veryLowLogprobThreshold) {
    reasons.push("very_low_confidence_token");
  }

  const reliable =
    confidence >= confidenceConfig.minimumReliableConfidence &&
    lowTokenFraction <= confidenceConfig.maximumReliableLowTokenFraction &&
    minimumLogprob >= confidenceConfig.veryLowLogprobThreshold;

  const reviewable =
    confidence >= confidenceConfig.minimumReviewConfidence &&
    lowTokenFraction <= confidenceConfig.maximumReviewLowTokenFraction;

  return {
    confidence: roundMetric(confidence),
    quality: reliable ? "reliable" : reviewable ? "review_recommended" : "unavailable",
    reasons,
    metrics: {
      average_logprob: roundMetric(averageLogprob),
      minimum_logprob: roundMetric(minimumLogprob),
      low_confidence_token_fraction: roundMetric(lowTokenFraction),
      token_count: values.length,
    },
  };
}

export function normalizedTranscriptWords(value: string) {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function transcriptWordErrorRate(reference: string, candidate: string) {
  const expected = normalizedTranscriptWords(reference);
  const actual = normalizedTranscriptWords(candidate);

  if (expected.length === 0) {
    return actual.length === 0 ? 0 : 1;
  }

  const previous = Array.from({ length: actual.length + 1 }, (_, index) => index);

  for (let row = 1; row <= expected.length; row += 1) {
    const current = [row];

    for (let column = 1; column <= actual.length; column += 1) {
      const substitutionCost = expected[row - 1] === actual[column - 1] ? 0 : 1;
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + substitutionCost,
      );
    }

    previous.splice(0, previous.length, ...current);
  }

  return previous[actual.length] / expected.length;
}

export function transcriptsMateriallyDisagree(reference: string, candidate: string) {
  return (
    transcriptWordErrorRate(reference, candidate) >
    confidenceConfig.maximumReliableTranscriptDisagreement
  );
}
