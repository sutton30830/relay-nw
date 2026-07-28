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
      priority: null,
      priority_reason: null,
      recording_sid: "sample-recording-1",
      recording_url: null,
      recording_duration: 18,
      recording_status: "completed",
      voicemail_transcript: "Hi, this is Marcus. My kitchen sink is backing up and the disposal is humming. I am hoping someone can come by today if possible.",
      voicemail_summary: "Kitchen sink is backing up and the disposal is humming; wants someone today if possible.",
      voicemail_transcription_status: "completed",
      voicemail_transcription_error: null,
      voicemail_transcribed_at: new Date(now - 12 * 60_000).toISOString(),
      inbound_messages: [
        {
          id: "sample-message-reply-1",
          message_sid: "sample-inbound-1",
          from_phone: "+12065550134",
          to_phone: "+14253689655",
          body: "Can someone come this afternoon?",
          created_at: new Date(now - 9 * 60_000).toISOString(),
        },
      ],
      outbound_messages: [
        {
          id: "sample-outbound-1",
          lead_id: "sample-marcus",
          twilio_message_sid: "sample-message-1",
          from_phone: "+14253689655",
          to_phone: "+12065550134",
          body: "Hi, this is Relay Plumbing. We missed your call. How can we help?",
          status: "sent",
          error: null,
          created_at: new Date(now - 14 * 60_000).toISOString(),
          updated_at: new Date(now - 14 * 60_000).toISOString(),
        },
      ],
      deleted_at: null,
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
      priority: null,
      priority_reason: null,
      recording_sid: null,
      recording_url: null,
      recording_duration: null,
      recording_status: null,
      voicemail_transcript: null,
      voicemail_summary: null,
      voicemail_transcription_status: null,
      voicemail_transcription_error: null,
      voicemail_transcribed_at: null,
      inbound_messages: [],
      outbound_messages: [],
      deleted_at: null,
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
      priority: null,
      priority_reason: null,
      recording_sid: null,
      recording_url: null,
      recording_duration: null,
      recording_status: null,
      voicemail_transcript: null,
      voicemail_summary: null,
      voicemail_transcription_status: null,
      voicemail_transcription_error: null,
      voicemail_transcribed_at: null,
      inbound_messages: [],
      outbound_messages: [],
      deleted_at: null,
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
  if (!cents || cents <= 0) return "No value entered";
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

export type SetupRequestField = {
  label: string;
  value: string;
};

const SETUP_REQUEST_PREFIX = "Relay NW setup request";

export function parseSetupRequestMessage(message: string | null | undefined): SetupRequestField[] {
  if (!message?.startsWith(SETUP_REQUEST_PREFIX)) {
    return [];
  }

  return message
    .split("\n")
    .slice(1)
    .map((line) => {
      const separatorIndex = line.indexOf(":");
      if (separatorIndex === -1) return null;

      const label = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();

      if (!label || !value) return null;

      return { label, value };
    })
    .filter((field): field is SetupRequestField => Boolean(field));
}

export function setupRequestSummary(fields: SetupRequestField[]) {
  if (fields.length === 0) return null;

  const fieldValue = (label: string) => fields.find((field) => field.label === label)?.value;
  const businessName = fieldValue("Business name");
  const ownerName = fieldValue("Owner name");
  const businessType = fieldValue("Business type");

  if (businessName && ownerName && businessType) {
    return `${ownerName} requested setup for ${businessName}, a ${businessType.toLowerCase()} business.`;
  }

  if (businessName && ownerName) {
    return `${ownerName} requested setup for ${businessName}.`;
  }

  if (businessName) {
    return `Setup request for ${businessName}.`;
  }

  return "New setup request from the intake form.";
}

export function needsAttention(lead: Lead) {
  return lead.status === "new" && (lead.sms_status === "failed" || lead.sms_status === "undelivered");
}

export function leadPriorityText(lead: Lead) {
  return [
    lead.inbound_messages?.map((message) => message.body).join(" "),
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
    return { level: "fast", label: "Call ASAP", reason: "callback timing was set manually" };
  }

  if (lead.reply_priority_override === "today") {
    return { level: "today", label: "Call today", reason: "callback timing was set manually" };
  }

  if (lead.reply_priority_override === "normal") {
    return { level: "normal", label: "Routine", reason: null };
  }

  // Server-side classification (persisted at voicemail transcription). The client
  // regex below stays as a fallback for leads that predate it, and can still
  // upgrade a server "normal" when newer text (e.g. an inbound reply) is urgent.
  if (lead.priority === "fast") {
    return { level: "fast", label: "Call ASAP", reason: lead.priority_reason };
  }

  if (lead.priority === "today") {
    return { level: "today", label: "Call today", reason: lead.priority_reason };
  }

  const text = leadPriorityText(lead);

  for (const item of FAST_REPLY_PATTERNS) {
    if (item.pattern.test(text)) {
      return { level: "fast", label: "Call ASAP", reason: item.reason };
    }
  }

  for (const item of TODAY_REPLY_PATTERNS) {
    if (item.pattern.test(text)) {
      return { level: "today", label: "Call today", reason: item.reason };
    }
  }

  return { level: "normal", label: "Routine", reason: null };
}


export function getLeadNextAction(lead: Lead, now: number): NextAction | null {
  const priority = getLeadPriority(lead);
  const summaryGenerating =
    !lead.voicemail_summary && lead.voicemail_transcription_status === "processing";
  const summaryPreparing =
    shouldShowVoicemailSummaryProgress(lead, now) && lead.voicemail_transcription_status !== "processing";
  const latestReply = lead.inbound_messages?.[0];

  if (latestReply && lead.status === "new") {
    return {
      label: "Customer replied",
      detail: latestReply.body,
      icon: "message",
      tone: "warning",
    };
  }

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

export function getFollowUpCue(lead: Lead) {
  if (needsAttention(lead)) {
    return { label: "Text failed", tone: "danger" };
  }

  if (isBookedLead(lead) && !lead.job_value_cents) {
    return { label: "Add value", tone: "good" };
  }

  const priority = getLeadPriority(lead);
  if (priority.level === "fast") {
    return { label: priority.label, tone: "danger" };
  }

  if (priority.level === "today") {
    return { label: priority.label, tone: "warning" };
  }

  if (lead.voicemail_summary) {
    return { label: "Voicemail", tone: "good" };
  }

  return { label: "Follow up", tone: "normal" };
}

export function getFollowUpReason(lead: Lead) {
  if (needsAttention(lead)) {
    return "The automatic text did not go through, so call this person directly.";
  }

  if (isBookedLead(lead) && !lead.job_value_cents) {
    return "This job is booked. Add the value so Relay can show what was recovered.";
  }

  const priority = getLeadPriority(lead);
  if (priority.reason) {
    return priority.reason;
  }

  if (lead.voicemail_summary) {
    return lead.voicemail_summary;
  }

  if (lead.message && lead.message !== LEGACY_FORWARDING_MESSAGE) {
    return lead.message;
  }

  if (lead.recording_sid) {
    return "A voicemail is attached. Listen before calling back.";
  }

  return "New missed call. Call back while the request is still fresh.";
}

// One card per caller: repeat calls from the same number collapse into the most
// recent lead, with a count so the owner sees "Called 3×" instead of three cards.
// The conversation thread is joined by phone, so nothing is hidden in the drawer.
export function condenseLeadsByPhone(leads: Lead[]) {
  const callCounts = new Map<string, number>();
  const newestByPhone = new Map<string, Lead>();

  for (const lead of leads) {
    callCounts.set(lead.phone, (callCounts.get(lead.phone) ?? 0) + 1);
    const current = newestByPhone.get(lead.phone);
    if (!current || new Date(lead.created_at).getTime() > new Date(current.created_at).getTime()) {
      newestByPhone.set(lead.phone, lead);
    }
  }

  const condensed = leads.filter((lead) => newestByPhone.get(lead.phone)?.id === lead.id);

  return { leads: condensed, callCounts };
}

// "N calls" must be the truth about how many times this number called — it
// counts every lead row for the phone, including soft-deleted ones, so the
// number never shifts when a card is trashed or restored.
export function countCallsByPhone(leads: Lead[]) {
  const counts = new Map<string, number>();

  for (const lead of leads) {
    counts.set(lead.phone, (counts.get(lead.phone) ?? 0) + 1);
  }

  return counts;
}

export function sortLeadsForWork(leads: Lead[]) {
  return [...leads].sort((a, b) => {
    const timeDiff = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (timeDiff !== 0) return timeDiff;

    return b.id.localeCompare(a.id);
  });
}

export function isBookedLead(lead: Lead) {
  return Boolean(lead.booked_at || lead.status === "booked");
}

export function countLeads(leads: Lead[]): LeadCounts {
  const visibleLeads = leads.filter((lead) => !lead.deleted_at);

  return {
    all: visibleLeads.length,
    new: visibleLeads.filter((lead) => lead.status === "new").length,
    actionable: visibleLeads.filter((lead) => lead.status === "new" || lead.status === "contacted").length,
    contacted: visibleLeads.filter((lead) => lead.status === "contacted").length,
    booked: visibleLeads.filter(isBookedLead).length,
    dead: visibleLeads.filter((lead) => lead.status === "dead").length,
    trash: leads.filter((lead) => lead.deleted_at).length,
    smsIssues: visibleLeads.filter(needsAttention).length,
    bookedValueCents: visibleLeads
      .filter(isBookedLead)
      .reduce((total, lead) => total + (lead.job_value_cents ?? 0), 0),
    bookedWithValue: visibleLeads.filter((lead) => isBookedLead(lead) && lead.job_value_cents).length,
  };
}

export function leadMatchesSearch(lead: Lead, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return [
    lead.name || "Unknown caller",
    lead.phone,
    lead.message,
    lead.notes,
    lead.inbound_messages?.map((message) => message.body).join(" "),
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
  if (!lead.recording_sid || lead.voicemail_summary) {
    return false;
  }

  const status = lead.voicemail_transcription_status;

  // A finished transcription is not "in progress" — even when it produced no
  // usable summary (e.g. the caller said nothing actionable). Without this, a
  // recent voicemail keeps spinning "Preparing summary…" for the whole recency
  // window despite already being done.
  if (status === "completed" || status === "failed") {
    return false;
  }

  // Actively transcribing, queued, or a brand-new voicemail waiting for
  // auto-transcription to kick in.
  return status === "processing" || status === "pending" || isRecentLead(lead, now);
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
    if (filter === "trash") {
      return Boolean(lead.deleted_at) && leadMatchesSearch(lead, query);
    }

    if (lead.deleted_at) {
      return false;
    }

    const matchesFilter = filter === "all"
      || (filter === "booked" && isBookedLead(lead))
      || lead.status === filter;
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
    return "Auto-text is off for now. Use your phone to follow up.";
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
