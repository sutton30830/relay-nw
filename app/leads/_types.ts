import type { LeadStatus, ReplyPriorityOverride } from "@/lib/supabase";

export type Filter = "all" | "new" | "contacted" | "dead" | "trash";

export type LeadCounts = Record<Filter, number> & {
  actionable: number;
  booked: number;
  smsIssues: number;
  bookedValueCents: number;
  bookedWithValue: number;
};

export type LeadPatch = {
  name?: string | null;
  status?: LeadStatus;
  notes?: string | null;
  booked?: boolean;
  jobValueCents?: number | null;
  replyPriorityOverride?: ReplyPriorityOverride;
  voicemailSummary?: string | null;
  deleted?: boolean;
};

export type TranscribeResponse = {
  transcript: string;
  // null when the voicemail had no usable content to summarize — the UI shows
  // an honest "listen to the voicemail" fallback instead of vague boilerplate.
  summary: string | null;
  status: "completed";
};

export type TranscribeResult =
  | { ok: true; data: TranscribeResponse }
  | { ok: false; error: string };

export type ReplyPriority = {
  level: "fast" | "today" | "normal";
  label: string;
  reason: string | null;
};

export type NextAction = {
  label: string;
  detail: string;
  icon: "alertTriangle" | "check" | "clock" | "message" | "phone" | "sparkle" | "star";
  tone: "danger" | "good" | "normal" | "warning";
};
