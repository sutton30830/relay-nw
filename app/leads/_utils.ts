import type { Lead } from "@/lib/supabase";
import type { Filter, LeadCounts, NextAction, ReplyPriority } from "./_types";
import { AUTO_VOICEMAIL_SUMMARY_LOOKBACK_MS, FAST_REPLY_PATTERNS, LEGACY_FORWARDING_MESSAGE, TODAY_REPLY_PATTERNS } from "./_constants";

export function createSampleLeads(): Lead[] {
  const now = Date.now();

  return [
    {
      id: "sample-marcus",
      call_sid: "sample-call-1",
      name: "Marcus Tillman",
      phone: "+12065550134",
      message: "Kitchen sink is backing up and the disposal is humming. Hoping someone can come by today if possible.",
      notes: "Prefers text. Mentioned they are near Ballard.",
      booked_at: null,
      job_value_cents: null,
      source: "missed_call",
      status: "new",
      sms_status: "undelivered",
      sms_error: "Auto-text could not be delivered.",
      twilio_message_sid: "sample-message-1",
      sms_updated_at: new Date(now - 13 * 60_000).toISOString(),
      reply_priority_override: null,
      recording_sid: "sample-recording-1",
      recording_url: null,
      recording_duration: 18,
      recording_status: "completed",
      voicemail_transcript: "Hi, this is Marcus. My kitchen sink is backing up and the disposal is humming. I am hoping someone can come by today if possible.",
      voicemail_summary: "Kitchen sink is backing up and the disposal is humming; wants someone today if possible.",
      voicemail_transcription_status: "completed",
      voicemail_transcription_error: null,
      voicemail_transcribed_at: new Date(now - 12 * 60_000).toISOString(),
      created_at: new Date(now - 14 * 60_000).toISOString(),
    },
    {
      id: "sample-priya",
      call_sid: null,
      name: "Priya Shah",
      phone: "+12065550187",
      message: "Water heater is making a popping noise. Flexible tomorrow morning or early afternoon.",
      notes: "",
      booked_at: null,
      job_value_cents: null,
      source: "intake_form",
      status: "contacted",
      sms_status: null,
      sms_error: null,
      twilio_message_sid: null,
      sms_updated_at: null,
      reply_priority_override: null,
      recording_sid: null,
      recording_url: null,
      recording_duration: null,
      recording_status: null,
      voicemail_transcript: null,
      voicemail_summary: null,
      voicemail_transcription_status: null,
      voicemail_transcription_error: null,
      voicemail_transcribed_at: null,
      created_at: new Date(now - 52 * 60_000).toISOString(),
    },
    {
      id: "sample-eli",
      call_sid: "sample-call-2",
      name: "Eli Ramirez",
      phone: "+12065550192",
      message: "Outdoor faucet is leaking near the garage.",
      notes: "Left voicemail. Try again after 4pm.",
      booked_at: new Date(now - 2 * 60 * 60_000).toISOString(),
      job_value_cents: 42500,
      source: "missed_call",
      status: "dead",
      sms_status: "sent",
      sms_error: null,
      twilio_message_sid: "sample-message-2",
      sms_updated_at: new Date(now - 3 * 60 * 60_000).toISOString(),
      reply_priority_override: null,
      recording_sid: null,
      recording_url: null,
      recording_duration: null,
      recording_status: null,
      voicemail_transcript: null,
      voicemail_summary: null,
      voicemail_transcription_status: null,
      voicemail_transcription_error: null,
      voicemail_transcribed_at: null,
      created_at: new Date(now - 3 * 60 * 60_000).toISOString(),
    },
  ];
}

export function formatRelativeTime(value: string, now: number) {
  const createdAt = new Date(value).getTime();
  const diffMinutes = Math.floor(Math.max(0, now - createdAt) / 60_000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

export function formatCurrency(cents: number | null | undefined) {
  if (!cents) return "$0";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function dollarsToCents(value: string) {
  const normalized = value.replace(/[$,\s]/g, "");
  if (!normalized) return null;

  const dollars = Number(normalized);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;

  return Math.round(dollars * 100);
}

export function centsToInputValue(cents: number | null) {
  return cents && cents > 0 ? String(Math.round(cents / 100)) : "";
}

export function initials(lead: Lead) {
  if (!lead.name) return null;
  return lead.name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function sourceLabel(source: Lead["source"]) {
  return source === "missed_call" ? "missed call" : "intake form";
}

export function needsAttention(lead: Lead) {
  return lead.status === "new" && (lead.sms_status === "failed" || lead.sms_status === "undelivered");
}

export function leadPriorityText(lead: Lead) {
  return [
    lead.voicemail_summary,
    lead.message === LEGACY_FORWARDING_MESSAGE ? null : lead.message,
    lead.voicemail_transcript,
    lead.notes,
  ]
    .filter(Boolean)
    .join(" ");
}

export function getLeadPriority(lead: Lead): ReplyPriority {
  if (lead.reply_priority_override === "fast") {
    return { level: "fast", label: "Fast reply", reason: "priority was set manually" };
  }

  if (lead.reply_priority_override === "today") {
    return { level: "today", label: "Today", reason: "priority was set manually" };
  }

  if (lead.reply_priority_override === "normal") {
    return { level: "normal", label: "Normal", reason: null };
  }

  const text = leadPriorityText(lead);

  for (const item of FAST_REPLY_PATTERNS) {
    if (item.pattern.test(text)) {
      return { level: "fast", label: "Fast reply", reason: item.reason };
    }
  }

  for (const item of TODAY_REPLY_PATTERNS) {
    if (item.pattern.test(text)) {
      return { level: "today", label: "Today", reason: item.reason };
    }
  }

  return { level: "normal", label: "Normal", reason: null };
}


export function getLeadNextAction(lead: Lead, now: number): NextAction | null {
  const priority = getLeadPriority(lead);
  const summaryGenerating =
    !lead.voicemail_summary && lead.voicemail_transcription_status === "processing";
  const summaryPreparing =
    shouldShowVoicemailSummaryProgress(lead, now) && lead.voicemail_transcription_status !== "processing";

  if (needsAttention(lead)) {
    return {
      label: "Call directly",
      detail: "Auto-text did not go through.",
      icon: "alertTriangle",
      tone: "danger",
    };
  }

  if (isBookedLead(lead) && !lead.job_value_cents) {
    return {
      label: "Add booked value",
      detail: "Track what this booked job was worth.",
      icon: "star",
      tone: "good",
    };
  }

  if (lead.status === "contacted") {
    return {
      label: "Choose outcome",
      detail: "Mark booked or closed after follow-up.",
      icon: "clock",
      tone: "warning",
    };
  }

  if (priority.level === "fast") {
    return {
      label: "Call back now",
      detail: "This looks time-sensitive.",
      icon: "alertTriangle",
      tone: "danger",
    };
  }

  if (summaryGenerating || summaryPreparing) {
    return {
      label: "Summary generating",
      detail: "Relay is turning the voicemail into a quick request.",
      icon: "sparkle",
      tone: "normal",
    };
  }

  return null;
}

export function prioritySortScore(lead: Lead) {
  if (lead.status !== "new") return 3;

  const priority = getLeadPriority(lead).level;
  if (priority === "fast") return 0;
  if (priority === "today") return 1;
  return 2;
}

export function sortLeadsForWork(leads: Lead[]) {
  return [...leads].sort((a, b) => {
    const priorityDiff = prioritySortScore(a) - prioritySortScore(b);
    if (priorityDiff !== 0) return priorityDiff;

    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

export function followUpQueueScore(lead: Lead) {
  if (needsAttention(lead)) return 0;

  const priority = getLeadPriority(lead).level;
  if (priority === "fast") return 1;
  if (priority === "today") return 2;
  if (lead.voicemail_summary) return 3;
  if (lead.recording_sid) return 4;
  if (lead.message && lead.message !== LEGACY_FORWARDING_MESSAGE) return 5;
  return 6;
}

export function getFollowUpQueue(leads: Lead[]) {
  return leads
    .filter((lead) => lead.status === "new" && !isBookedLead(lead))
    .sort((a, b) => {
      const scoreDiff = followUpQueueScore(a) - followUpQueueScore(b);
      if (scoreDiff !== 0) return scoreDiff;

      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    })
    .slice(0, 4);
}

export function getFollowUpReason(lead: Lead) {
  if (needsAttention(lead)) {
    return "Auto-text did not go through. Call this person directly.";
  }

  const priority = getLeadPriority(lead);
  if (priority.level === "fast") {
    return priority.reason ? `Fast reply: ${priority.reason}.` : "This request looks time-sensitive.";
  }

  if (priority.level === "today") {
    return priority.reason ? `Today: ${priority.reason}.` : "They may need help today.";
  }

  if (lead.voicemail_summary) {
    return lead.voicemail_summary;
  }

  if (lead.recording_sid) {
    return "Voicemail saved. Listen or call back while the job is fresh.";
  }

  if (lead.message && lead.message !== LEGACY_FORWARDING_MESSAGE) {
    return lead.message;
  }

  return "New missed call. Call back before they move on.";
}

export function getFollowUpCue(lead: Lead) {
  if (needsAttention(lead)) {
    return { label: "SMS failed", tone: "danger" };
  }

  const priority = getLeadPriority(lead).level;
  if (priority === "fast") {
    return { label: "Urgent", tone: "danger" };
  }

  if (priority === "today") {
    return { label: "Today", tone: "warning" };
  }

  if (lead.voicemail_summary) {
    return { label: "Summary ready", tone: "good" };
  }

  if (lead.recording_sid) {
    return { label: "Voicemail", tone: "good" };
  }

  if (lead.message && lead.message !== LEGACY_FORWARDING_MESSAGE) {
    return { label: "Request details", tone: "normal" };
  }

  return { label: "Fresh call", tone: "normal" };
}

export function isBookedLead(lead: Lead) {
  return Boolean(lead.booked_at || lead.status === "booked" || lead.job_value_cents);
}

export function countLeads(leads: Lead[]): LeadCounts {
  return {
    all: leads.length,
    new: leads.filter((lead) => lead.status === "new").length,
    actionable: leads.filter((lead) => lead.status === "new" || lead.status === "contacted").length,
    contacted: leads.filter((lead) => lead.status === "contacted").length,
    dead: leads.filter((lead) => lead.status === "dead").length,
    smsIssues: leads.filter(needsAttention).length,
    bookedValueCents: leads
      .filter(isBookedLead)
      .reduce((total, lead) => total + (lead.job_value_cents ?? 0), 0),
    bookedWithValue: leads.filter((lead) => isBookedLead(lead) && lead.job_value_cents).length,
  };
}

export function leadMatchesSearch(lead: Lead, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return [
    lead.name,
    lead.phone,
    lead.message,
    lead.notes,
    lead.voicemail_summary,
    lead.voicemail_transcript,
    getLeadPriority(lead).label,
    sourceLabel(lead.source),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

export function isRecentLead(lead: Lead, now: number) {
  const createdAt = Date.parse(lead.created_at);
  return Number.isFinite(createdAt) && now - createdAt <= AUTO_VOICEMAIL_SUMMARY_LOOKBACK_MS;
}

export function shouldShowVoicemailSummaryProgress(lead: Lead, now: number) {
  return Boolean(
    lead.recording_sid &&
      !lead.voicemail_summary &&
      lead.voicemail_transcription_status !== "failed" &&
      (lead.voicemail_transcription_status === "processing" || isRecentLead(lead, now)),
  );
}

export function shouldAutoSummarizeVoicemail(lead: Lead, now: number, initiallyLoadedLeadIds: Set<string>) {
  if (initiallyLoadedLeadIds.has(lead.id)) {
    return false;
  }

  if (!lead.recording_sid || lead.voicemail_summary || lead.voicemail_transcript) {
    return false;
  }

  if (lead.voicemail_transcription_status === "processing" || lead.voicemail_transcription_status === "failed") {
    return false;
  }

  return isRecentLead(lead, now);
}

export function filterLeads(leads: Lead[], filter: Filter, query: string) {
  return leads.filter((lead) => {
    const matchesFilter = filter === "all" || lead.status === filter;
    return matchesFilter && leadMatchesSearch(lead, query);
  });
}


export function humanVoicemailError(error: string | null | undefined) {
  if (!error) {
    return "Unable to summarize this voicemail. Try again or listen to the recording.";
  }

  if (error.includes("Twilio recording download failed with 404")) {
    return "Twilio no longer has this recording available. Try a newer voicemail or listen from Twilio.";
  }

  if (error.includes("insufficient_quota")) {
    return "OpenAI billing or quota is blocking transcription.";
  }

  if (error.includes("Missing scopes") || error.includes("insufficient permissions")) {
    return "The OpenAI API key does not have permission to transcribe audio.";
  }

  return "Unable to summarize this voicemail. Try again or listen to the recording.";
}

export function followUpStatusText(lead: Lead) {
  if (lead.source !== "missed_call") {
    return "This lead came from the intake form.";
  }

  if (lead.sms_status === "sent") {
    return "Auto-text sent by Relay.";
  }

  if (lead.sms_status === "delivered") {
    return "Auto-text delivered.";
  }

  if (lead.sms_status === "failed" || lead.sms_status === "undelivered") {
    return "Auto-text failed. Follow up manually.";
  }

  if (lead.sms_status === "skipped_recent") {
    return "Auto-text skipped because this caller was recently texted.";
  }

  if (lead.sms_status === "skipped_opt_out") {
    return "Auto-text skipped because this caller opted out.";
  }

  if (lead.sms_status === "skipped_disabled") {
    return "Auto-text is currently turned off. Follow up manually.";
  }

  return "Auto-text pending or waiting on SMS setup.";
}

export function formatDuration(seconds: number | null) {
  if (!seconds) return "Voice message";
  if (seconds < 60) return `${seconds}s voice message`;

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s voice message`;
}
