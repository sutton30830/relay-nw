// Single source of truth for lead urgency classification. Runs server-side in the
// voicemail pipeline (persisted to leads.priority) and client-side as a fallback for
// leads created before classification existed.

export type LeadPriorityLevel = "fast" | "today" | "normal";

export type PriorityClassification = {
  level: LeadPriorityLevel;
  reason: string | null;
};

export const FAST_REPLY_PATTERNS = [
  { pattern: /\bemergency\b/i, reason: "mentioned emergency" },
  { pattern: /\basap\b/i, reason: "asked for ASAP help" },
  { pattern: /\bright away\b/i, reason: "asked for help right away" },
  { pattern: /\bimmediately\b/i, reason: "asked for immediate help" },
  { pattern: /\bnow\b/i, reason: "asked for help now" },
  { pattern: /\bflood(?:ing)?\b/i, reason: "mentioned flooding" },
  { pattern: /\bburst\b/i, reason: "mentioned something burst" },
  { pattern: /\bno heat\b/i, reason: "mentioned no heat" },
  { pattern: /\bno power\b/i, reason: "mentioned no power" },
  { pattern: /\blocked out\b/i, reason: "mentioned being locked out" },
  { pattern: /\bnot working\b/i, reason: "said something is not working" },
  { pattern: /\bwater everywhere\b/i, reason: "mentioned water everywhere" },
];

export const TODAY_REPLY_PATTERNS = [
  { pattern: /\btoday\b/i, reason: "asked about today" },
  { pattern: /\btonight\b/i, reason: "asked about tonight" },
  { pattern: /\bthis morning\b/i, reason: "mentioned this morning" },
  { pattern: /\bthis afternoon\b/i, reason: "mentioned this afternoon" },
  { pattern: /\bthis evening\b/i, reason: "mentioned this evening" },
  { pattern: /\btomorrow\b/i, reason: "asked about tomorrow" },
  { pattern: /\bsoon\b/i, reason: "asked for help soon" },
  { pattern: /\bafter hours\b/i, reason: "mentioned after hours" },
];

export function classifyPriority(text: string | null | undefined): PriorityClassification {
  const haystack = (text ?? "").trim();

  if (!haystack) {
    return { level: "normal", reason: null };
  }

  for (const item of FAST_REPLY_PATTERNS) {
    if (item.pattern.test(haystack)) {
      return { level: "fast", reason: item.reason };
    }
  }

  for (const item of TODAY_REPLY_PATTERNS) {
    if (item.pattern.test(haystack)) {
      return { level: "today", reason: item.reason };
    }
  }

  return { level: "normal", reason: null };
}
