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
export const UNDO_DELETE_MS = 7_000;
export const AUTO_VOICEMAIL_SUMMARY_LOOKBACK_MS = 10 * 60 * 1000;
export const INBOX_REFRESH_MS = 8_000;
export const RELATIVE_TIME_TICK_MS = 15_000;
// How long to wait after the last keystroke before firing a server-side search.
export const SEARCH_DEBOUNCE_MS = 300;

export const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "booked", label: "Booked" },
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

// Single source of truth lives server-side in lib/priority.ts; re-exported here for
// the client-side fallback used by leads that predate persisted classification.
export { FAST_REPLY_PATTERNS, TODAY_REPLY_PATTERNS } from "@/lib/priority";
