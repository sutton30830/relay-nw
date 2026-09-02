export const MIN_VOICEMAIL_DURATION_SECONDS = 3;
export const NO_USABLE_VOICEMAIL_MESSAGE =
  "No usable voicemail was recorded. Relay did not generate a transcript.";
export const NO_SPEECH_VOICEMAIL_MESSAGE =
  "No clear spoken message was detected. Relay did not generate a transcript.";
// Written when the owner marks a transcript wrong. It is a human quality
// decision, not a provider failure: monitoring treats it as an expected
// suppression and the scheduled retry never re-transcribes over it.
export const OWNER_DISPUTED_TRANSCRIPT_MESSAGE =
  "You marked this transcript as wrong. Relay hid it and kept the recording.";

export function isOwnerDisputedTranscript(error: string | null | undefined) {
  return Boolean(error && /marked this transcript as wrong/i.test(error));
}

export function recordingIsTooShort(duration: number | null | undefined) {
  return typeof duration === "number" &&
    Number.isFinite(duration) &&
    duration < MIN_VOICEMAIL_DURATION_SECONDS;
}

export function hasUsableVoicemail(
  recordingSid: string | null | undefined,
  duration: number | null | undefined,
) {
  return Boolean(recordingSid) && !recordingIsTooShort(duration);
}

const SILENCE_HALLUCINATION_PATTERNS = [
  /\bfor more information,?\s+visit\s+(?:www\.)?fema\.gov\b/i,
  /\bthanks? for (?:watching|listening)\b/i,
  /\bsubtitles? (?:by|provided by)\b/i,
  /\bplease subscribe\b/i,
];

export function transcriptLooksLikeSilenceHallucination(
  transcript: string,
  duration: number | null | undefined,
) {
  const normalized = transcript.trim();
  if (!normalized) return true;

  if (SILENCE_HALLUCINATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  // A URL/domain from only a few seconds of audio is much more likely to be a
  // silence hallucination than a usable home-service voicemail. Longer vendor
  // or non-service messages may legitimately mention a website and are kept.
  return typeof duration === "number" &&
    duration <= 8 &&
    /\b(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|org|gov|net))\b/i.test(normalized);
}
