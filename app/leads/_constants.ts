import type { LeadStatus } from "@/lib/supabase";
import type { Filter } from "./_types";

export const STATUS_OPTIONS: LeadStatus[] = ["new", "contacted", "dead"];
export const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  booked: "Booked",
  dead: "Closed",
};

export const AUTO_VOICEMAIL_SUMMARY_LIMIT = 3;
export const AUTO_VOICEMAIL_SUMMARY_LOOKBACK_MS = 10 * 60 * 1000;
export const INBOX_REFRESH_MS = 8_000;
export const RELATIVE_TIME_TICK_MS = 15_000;

export const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "dead", label: "Closed" },
  { key: "trash", label: "Trash" },
];

export const QUICK_REPLIES = [
  "Thanks for reaching out. I can call you shortly.",
  "Can I come by tomorrow morning?",
  "Can you send a photo of the issue?",
  "I can get you on the schedule today.",
];

export const LEGACY_FORWARDING_MESSAGE = "Forwarded missed call from existing business number.";

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
