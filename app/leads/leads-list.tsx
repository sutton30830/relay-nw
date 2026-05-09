"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import type { Lead, LeadStatus } from "@/lib/supabase";

const STATUS_OPTIONS: LeadStatus[] = ["new", "contacted", "dead"];
const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  booked: "Booked",
  dead: "Closed",
};

type Filter = "all" | Exclude<LeadStatus, "booked">;

type LeadCounts = Record<Filter, number> & {
  actionable: number;
  smsIssues: number;
  bookedValueCents: number;
  bookedWithValue: number;
};

type LeadPatch = {
  name?: string | null;
  status?: LeadStatus;
  notes?: string | null;
  booked?: boolean;
  jobValueCents?: number | null;
  voicemailSummary?: string | null;
};

type TranscribeResponse = {
  transcript: string;
  summary: string;
  status: "completed";
};

type TranscribeResult =
  | { ok: true; data: TranscribeResponse }
  | { ok: false; error: string };

const AUTO_VOICEMAIL_SUMMARY_LIMIT = 3;
const AUTO_VOICEMAIL_SUMMARY_LOOKBACK_MS = 10 * 60 * 1000;
const INBOX_REFRESH_MS = 8_000;
const RELATIVE_TIME_TICK_MS = 15_000;

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "dead", label: "Closed" },
];

const QUICK_REPLIES = [
  "Thanks for reaching out. I can call you shortly.",
  "Can I come by tomorrow morning?",
  "Can you send a photo of the issue?",
  "I can get you on the schedule today.",
];

const LEGACY_FORWARDING_MESSAGE = "Forwarded missed call from existing business number.";

function createSampleLeads(): Lead[] {
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

function formatRelativeTime(value: string, now: number) {
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

function formatPhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

function formatCurrency(cents: number | null | undefined) {
  if (!cents) return "$0";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function dollarsToCents(value: string) {
  const normalized = value.replace(/[$,\s]/g, "");
  if (!normalized) return null;

  const dollars = Number(normalized);
  if (!Number.isFinite(dollars) || dollars <= 0) return null;

  return Math.round(dollars * 100);
}

function centsToInputValue(cents: number | null) {
  return cents && cents > 0 ? String(Math.round(cents / 100)) : "";
}

function initials(lead: Lead) {
  if (!lead.name) return null;
  return lead.name
    .split(" ")
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function sourceLabel(source: Lead["source"]) {
  return source === "missed_call" ? "missed call" : "intake form";
}

function needsAttention(lead: Lead) {
  return lead.status === "new" && (lead.sms_status === "failed" || lead.sms_status === "undelivered");
}

function isBookedLead(lead: Lead) {
  return Boolean(lead.booked_at || lead.status === "booked" || lead.job_value_cents);
}

function countLeads(leads: Lead[]): LeadCounts {
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

function leadMatchesSearch(lead: Lead, query: string) {
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
    sourceLabel(lead.source),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

function isRecentLead(lead: Lead, now: number) {
  const createdAt = Date.parse(lead.created_at);
  return Number.isFinite(createdAt) && now - createdAt <= AUTO_VOICEMAIL_SUMMARY_LOOKBACK_MS;
}

function shouldShowVoicemailSummaryProgress(lead: Lead, now: number) {
  return Boolean(
    lead.recording_sid &&
      !lead.voicemail_summary &&
      lead.voicemail_transcription_status !== "failed" &&
      (lead.voicemail_transcription_status === "processing" || isRecentLead(lead, now)),
  );
}

function shouldAutoSummarizeVoicemail(lead: Lead, now: number, initiallyLoadedLeadIds: Set<string>) {
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

function filterLeads(leads: Lead[], filter: Filter, query: string) {
  return leads.filter((lead) => {
    const matchesFilter = filter === "all" || lead.status === filter;
    return matchesFilter && leadMatchesSearch(lead, query);
  });
}

async function patchLead(id: string, body: LeadPatch) {
  try {
    const response = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return response.ok;
  } catch (error) {
    console.error("Failed to update lead from inbox", { leadId: id, error });
    return false;
  }
}

async function requestVoicemailSummary(id: string): Promise<TranscribeResult> {
  try {
    const response = await fetch(`/api/leads/${id}/transcribe`, {
      method: "POST",
    });

    const data = await response.json().catch(() => null) as TranscribeResponse | { error?: string } | null;

    if (!response.ok) {
      return {
        ok: false,
        error: humanVoicemailError(data && "error" in data ? data.error : null),
      };
    }

    return { ok: true, data: data as TranscribeResponse };
  } catch (error) {
    console.error("Failed to summarize voicemail from inbox", { leadId: id, error });
    return {
      ok: false,
      error: "Relay could not reach the transcription service. Try again in a minute.",
    };
  }
}

function humanVoicemailError(error: string | null | undefined) {
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

function followUpStatusText(lead: Lead) {
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

function StatusPill({ status }: { status: LeadStatus }) {
  return <span className={`chip status-pill--${status}`}>{STATUS_LABELS[status]}</span>;
}

function BookedBadge({ lead }: { lead: Lead }) {
  if (!isBookedLead(lead)) return null;

  return (
    <span className="chip chip-good">
      {lead.job_value_cents ? `${formatCurrency(lead.job_value_cents)} booked` : "Booked job"}
    </span>
  );
}

function SourceBadge({ source }: { source: Lead["source"] }) {
  if (source === "missed_call") return null;

  return (
    <span className="chip source-badge" style={{ textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
      <Icon name="inbox" size={12} />
      {sourceLabel(source)}
    </span>
  );
}

function SmsBadge({ lead }: { lead: Lead }) {
  if (!lead.sms_status || lead.source !== "missed_call") return null;

  if (lead.sms_status === "failed" || lead.sms_status === "undelivered") {
    return <span className="chip chip-danger sms-badge sms-badge--failed"><Icon name="alertTriangle" size={12} /> SMS failed</span>;
  }
  if (lead.sms_status === "delivered") {
    return <span className="chip chip-good sms-badge sms-badge--delivered"><Icon name="checkDouble" size={12} /> SMS delivered</span>;
  }
  if (lead.sms_status === "sent") {
    return <span className="chip chip-good sms-badge sms-badge--sent"><Icon name="checkDouble" size={12} /> SMS sent</span>;
  }
  if (lead.sms_status === "skipped_opt_out") {
    return <span className="chip chip-warn sms-badge sms-badge--optout"><Icon name="shield" size={12} /> Opted out</span>;
  }
  if (lead.sms_status === "skipped_recent") {
    return <span className="chip sms-badge sms-badge--recent"><Icon name="clock" size={12} /> Recently texted</span>;
  }
  if (lead.sms_status === "skipped_disabled") {
    return <span className="chip chip-warn sms-badge sms-badge--disabled"><Icon name="shield" size={12} /> SMS off</span>;
  }
  return <span className="chip chip-warn sms-badge sms-badge--pending"><Icon name="clock" size={12} /> SMS pending</span>;
}

function VoicemailBadge({ lead }: { lead: Lead }) {
  if (!lead.recording_sid) return null;

  return (
    <span className="chip chip-good">
      <Icon name="message" size={12} /> Voicemail
    </span>
  );
}

function formatDuration(seconds: number | null) {
  if (!seconds) return "Voice message";
  if (seconds < 60) return `${seconds}s voice message`;

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s voice message`;
}

function StatusControl({
  status,
  onChange,
}: {
  status: LeadStatus;
  onChange: (status: LeadStatus) => void;
}) {
  return (
    <div className="lead-card__status-ctrl">
      {STATUS_OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          className={`status-seg ${status === option ? "status-seg--on" : ""}`}
          onClick={() => onChange(option)}
        >
          {STATUS_LABELS[option]}
        </button>
      ))}
    </div>
  );
}

function BookedToggle({
  booked,
  onChange,
}: {
  booked: boolean;
  onChange: (booked: boolean) => void;
}) {
  return (
    <label className={`booked-toggle ${booked ? "booked-toggle--on" : ""}`}>
      <input
        type="checkbox"
        checked={booked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>Booked job</span>
    </label>
  );
}

function BookedValueInput({
  valueCents,
  onSave,
  compact = false,
}: {
  valueCents: number | null;
  onSave: (jobValueCents: number | null) => void;
  compact?: boolean;
}) {
  const [value, setValue] = useState(centsToInputValue(valueCents));

  useEffect(() => {
    setValue(centsToInputValue(valueCents));
  }, [valueCents]);

  function saveValue() {
    onSave(dollarsToCents(value));
  }

  return (
    <label className={`money-field ${compact ? "money-field--compact" : ""}`}>
      <span>$</span>
      <input
        inputMode="numeric"
        placeholder="0"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={saveValue}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur();
          }
        }}
        aria-label="Estimated booked job value"
      />
    </label>
  );
}

function LeadDrawer({
  lead,
  onClose,
  onStatus,
  onBooked,
  onName,
  onNotes,
  onSummary,
  onJobValue,
  onTranscribe,
  isTranscribing,
}: {
  lead: Lead;
  onClose: () => void;
  onStatus: (id: string, status: LeadStatus) => void;
  onBooked: (id: string, booked: boolean) => void;
  onName: (id: string, name: string | null) => void;
  onNotes: (id: string, notes: string) => void;
  onSummary: (id: string, summary: string) => void;
  onJobValue: (id: string, jobValueCents: number | null) => void;
  onTranscribe: (id: string) => void;
  isTranscribing: boolean;
}) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerHeadRef = useRef<HTMLElement | null>(null);
  const [name, setName] = useState(lead.name ?? "");
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [summary, setSummary] = useState(lead.voicemail_summary ?? "");
  const booked = isBookedLead(lead);

  function resetDrawerScroll() {
    window.scrollTo({ top: 0, behavior: "auto" });

    if (drawerRef.current) {
      drawerRef.current.scrollTop = 0;
    }

    drawerHeadRef.current?.focus({ preventScroll: false });
  }

  useLayoutEffect(() => {
    resetDrawerScroll();
  }, [lead.id]);

  useEffect(() => {
    resetDrawerScroll();

    const firstFrame = window.requestAnimationFrame(resetDrawerScroll);
    const secondFrame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(resetDrawerScroll);
    });
    const finalReset = window.setTimeout(resetDrawerScroll, 80);

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      window.clearTimeout(finalReset);
    };
  }, [lead.id]);

  useEffect(() => {
    setName(lead.name ?? "");
  }, [lead.id, lead.name]);

  useEffect(() => {
    setNotes(lead.notes ?? "");
  }, [lead.id, lead.notes]);

  useEffect(() => {
    setSummary(lead.voicemail_summary ?? "");
  }, [lead.id, lead.voicemail_summary]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function saveName() {
    const nextName = name.trim();
    const savedName = nextName || null;

    if (name !== nextName) {
      setName(nextName);
    }

    if ((lead.name ?? null) !== savedName) {
      onName(lead.id, savedName);
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside
        ref={drawerRef}
        className="drawer"
        role="dialog"
        aria-label={`Lead ${lead.name || lead.phone}`}
      >
        <header ref={drawerHeadRef} className="drawer__head" tabIndex={-1}>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
            <Icon name="x" size={14} /> Close
          </button>
        </header>

        <div className="drawer__hero">
          <div className="lead-card__avatar lead-card__avatar--lg">
            {initials(lead) ?? <Icon name="user" size={22} />}
          </div>
          <div>
            <h2 className="t-display" style={{ fontSize: 34, margin: 0 }}>
              {lead.name || "Unknown caller"}
            </h2>
            <p className="t-mono" style={{ margin: "4px 0 0", color: "var(--ink-2)", fontSize: 15 }}>
              {formatPhone(lead.phone)}
            </p>
            <label className="drawer__name-field">
              <span className="t-eyebrow">Caller name</span>
              <input
                className="field"
                maxLength={100}
                placeholder="Add caller name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                onBlur={saveName}
              />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusPill status={lead.status} />
              <BookedBadge lead={lead} />
              <SourceBadge source={lead.source} />
              <SmsBadge lead={lead} />
              <VoicemailBadge lead={lead} />
            </div>
          </div>
        </div>

        <div className="drawer__status-row">
          <span className="t-eyebrow">Status</span>
          <StatusControl status={lead.status} onChange={(status) => onStatus(lead.id, status)} />
        </div>

        <div className="drawer__value-row">
          <div>
            <p className="t-eyebrow">Outcome</p>
            <p className="drawer__value-copy">
              Mark booked and add the job value so Relay can track booked work.
            </p>
          </div>
          <BookedToggle booked={booked} onChange={(nextBooked) => onBooked(lead.id, nextBooked)} />
          <BookedValueInput
            valueCents={lead.job_value_cents}
            onSave={(jobValueCents) => onJobValue(lead.id, jobValueCents)}
          />
        </div>

        {lead.message ? (
          <div className="drawer__message">
            <p className="t-eyebrow">Request details</p>
            <p style={{ margin: "8px 0 0", lineHeight: 1.55 }}>{lead.message}</p>
          </div>
        ) : null}

        {lead.recording_sid ? (
          <div className="drawer__message voicemail-card">
            <div>
              <p className="t-eyebrow">Voicemail</p>
              <p style={{ margin: "8px 0 0", color: "var(--ink-2)" }}>
                {formatDuration(lead.recording_duration)}
              </p>
            </div>
            <audio className="voicemail-card__audio" controls src={`/api/recordings/${lead.recording_sid}`}>
              <a href={`/api/recordings/${lead.recording_sid}`}>Open voicemail</a>
            </audio>
            <div className="voicemail-ai">
              {lead.voicemail_summary ? (
                <div className="voicemail-ai__summary">
                  <label>
                    <span className="t-eyebrow">Quick summary</span>
                    <textarea
                      className="field voicemail-ai__summary-field"
                      rows={2}
                      value={summary}
                      onChange={(event) => setSummary(event.target.value)}
                      onBlur={() => onSummary(lead.id, summary)}
                    />
                  </label>
                </div>
              ) : null}
              {!lead.voicemail_summary && lead.voicemail_transcription_status === "processing" ? (
                <p className="voicemail-ai__status">
                  <Icon name="sparkle" size={13} /> Generating summary...
                </p>
              ) : null}
              {lead.voicemail_transcript ? (
                <details className="voicemail-ai__transcript">
                  <summary>Transcript</summary>
                  <p>{lead.voicemail_transcript}</p>
                </details>
              ) : null}
              {lead.voicemail_transcription_status === "failed" ? (
                <p className="voicemail-ai__error">
                  {lead.voicemail_transcription_error ??
                    "Unable to summarize this voicemail. Try again or listen to the recording."}
                </p>
              ) : null}
              {!lead.voicemail_summary && lead.voicemail_transcription_status !== "processing" ? (
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  disabled={isTranscribing}
                  onClick={() => onTranscribe(lead.id)}
                >
                  <Icon name="sparkle" size={13} />
                  {isTranscribing
                    ? "Summarizing..."
                    : lead.voicemail_transcription_status === "failed"
                      ? "Retry summary"
                      : "Summarize voicemail"}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="drawer__section-head">
          <p className="t-eyebrow">Follow-up</p>
          <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
            Use your phone for replies
          </span>
        </div>

        <div className="follow-up-panel">
          <div className={`follow-up-status ${lead.sms_status === "failed" || lead.sms_status === "skipped_disabled" ? "follow-up-status--warn" : ""}`}>
            <Icon name={lead.sms_status === "failed" || lead.sms_status === "skipped_disabled" ? "alertTriangle" : "message"} size={15} />
            <span>{followUpStatusText(lead)}</span>
          </div>
          <div className="follow-up-actions">
            <a className="btn btn-primary follow-up-actions__primary" href={`tel:${lead.phone}`}>
              <Icon name="phone" size={14} /> Call back
            </a>
            <a className="btn btn-secondary" href={`sms:${lead.phone}`}>
              <Icon name="message" size={14} /> Text
            </a>
          </div>
          <details className="follow-up-shortcuts">
            <summary>Text shortcuts</summary>
            <div className="follow-up-quick">
              {QUICK_REPLIES.map((template) => (
                <a
                  key={template}
                  className="quick-reply"
                  href={`sms:${lead.phone}?&body=${encodeURIComponent(template)}`}
                >
                  {template}
                </a>
              ))}
            </div>
          </details>
          <p className="follow-up-hint">
            Texting opens your phone's messages app.
          </p>
        </div>

        <div className="drawer__notes">
          <p className="t-eyebrow" style={{ marginBottom: 8 }}>Private notes</p>
          <textarea
            className="field"
            rows={3}
            placeholder="Private notes - only you see these."
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            onBlur={() => onNotes(lead.id, notes)}
          />
        </div>
      </aside>
    </>
  );
}

function LeadCard({
  lead,
  now,
  onOpen,
  onStatus,
  onBooked,
  onJobValue,
  expanded,
  onToggleDetails,
}: {
  lead: Lead;
  now: number;
  onOpen: (id: string) => void;
  onStatus: (id: string, status: LeadStatus) => void;
  onBooked: (id: string, booked: boolean) => void;
  onJobValue: (id: string, jobValueCents: number | null) => void;
  expanded: boolean;
  onToggleDetails: (id: string) => void;
}) {
  const attention = needsAttention(lead);
  const booked = isBookedLead(lead);
  const hasDetails = Boolean(lead.voicemail_transcript || lead.notes || lead.recording_sid);
  const detailsVisible = hasDetails && expanded;

  return (
    <article
      className={`lead-card ${attention ? "lead-card--attention" : ""}`}
      onClick={() => onOpen(lead.id)}
    >
      <div className="lead-card__head">
        <div className="lead-card__id">
          <div className="lead-card__avatar">{initials(lead) ?? <Icon name="user" size={14} />}</div>
          <div style={{ minWidth: 0 }}>
            <h3 className="lead-card__name">{lead.name || "Unknown caller"}</h3>
            <div className="lead-card__meta">
              <span className="t-mono" style={{ fontSize: 13 }}>{formatPhone(lead.phone)}</span>
              <span>·</span>
              <span>{formatRelativeTime(lead.created_at, now)}</span>
            </div>
          </div>
        </div>

        <div className="lead-card__badges">
          <StatusPill status={lead.status} />
          <BookedBadge lead={lead} />
          <SourceBadge source={lead.source} />
          <SmsBadge lead={lead} />
          <VoicemailBadge lead={lead} />
        </div>
      </div>

      {lead.message && lead.message !== LEGACY_FORWARDING_MESSAGE ? (
        <p className="lead-card__msg">{lead.message}</p>
      ) : null}

      {lead.voicemail_summary ? (
        <p className="lead-card__msg lead-card__summary">
          <strong>Voicemail summary:</strong> {lead.voicemail_summary}
        </p>
      ) : null}

      {!lead.voicemail_summary && lead.voicemail_transcription_status === "processing" ? (
        <div className="lead-card__msg lead-card__summary lead-card__summary--pending" role="status">
          <div className="lead-card__summary-pending-label">
            <Icon name="sparkle" size={13} /> Generating voicemail summary...
          </div>
          <div className="lead-card__summary-progress" aria-hidden="true" />
        </div>
      ) : null}

      {shouldShowVoicemailSummaryProgress(lead, now) && lead.voicemail_transcription_status !== "processing" ? (
        <div className="lead-card__msg lead-card__summary lead-card__summary--pending" role="status">
          <div className="lead-card__summary-pending-label">
            <Icon name="sparkle" size={13} /> Preparing voicemail summary...
          </div>
          <div className="lead-card__summary-progress" aria-hidden="true" />
        </div>
      ) : null}

      {attention ? (
        <div className="lead-card__alert">
          <Icon name="alertTriangle" size={14} />
          <span>{lead.sms_error || "SMS delivery failed"} - call them directly.</span>
        </div>
      ) : null}

      {booked ? (
        <div className="lead-card__value" onClick={(event) => event.stopPropagation()}>
          <span className="lead-card__value-label">Booked value</span>
          <BookedValueInput
            compact
            valueCents={lead.job_value_cents}
            onSave={(jobValueCents) => onJobValue(lead.id, jobValueCents)}
          />
        </div>
      ) : null}

      {detailsVisible ? (
        <div className="lead-card__details" onClick={(event) => event.stopPropagation()}>
          {lead.notes ? (
            <section>
              <p className="t-eyebrow">Private notes</p>
              <p>{lead.notes}</p>
            </section>
          ) : null}
          {lead.recording_sid ? (
            <audio className="lead-card__audio" controls src={`/api/recordings/${lead.recording_sid}`}>
              <a href={`/api/recordings/${lead.recording_sid}`}>Open voicemail</a>
            </audio>
          ) : null}
          {lead.voicemail_transcript ? (
            <details className="lead-card__transcript">
              <summary>Transcript</summary>
              <p>{lead.voicemail_transcript}</p>
            </details>
          ) : null}
        </div>
      ) : null}

      <div className="lead-card__actions" onClick={(event) => event.stopPropagation()}>
        <div className="lead-card__primary-actions">
          <a className="btn btn-primary btn-sm" href={`tel:${lead.phone}`}>
            <Icon name="phone" size={13} /> Call
          </a>
          {lead.status === "new" ? (
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => onStatus(lead.id, "contacted")}>
              Mark contacted
            </button>
          ) : null}
          {!booked ? (
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => onBooked(lead.id, true)}>
              Mark booked
            </button>
          ) : null}
        </div>
        <div className="lead-card__utility-actions">
          <a className="btn btn-ghost btn-sm" href={`sms:${lead.phone}`}>
            <Icon name="message" size={13} /> Text
          </a>
          {hasDetails ? (
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => onToggleDetails(lead.id)}>
              {detailsVisible ? "Hide details" : "Details"}
            </button>
          ) : null}
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => onOpen(lead.id)}>
            Open <Icon name="chevronRight" size={13} />
          </button>
        </div>
      </div>
    </article>
  );
}

export function LeadsList({
  leads,
  businessName,
}: {
  leads: Lead[];
  businessName: string;
}) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const initiallyLoadedLeadIds = useRef<Set<string>>(new Set(leads.map((lead) => lead.id)));
  const autoSummaryStartedIds = useRef<Set<string>>(new Set());
  const [items, setItems] = useState(leads);
  const [sampleItems, setSampleItems] = useState(() => createSampleLeads());
  const [sampleMode, setSampleMode] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [transcribingIds, setTranscribingIds] = useState<Set<string>>(() => new Set());
  const [expandedLeadIds, setExpandedLeadIds] = useState<Set<string>>(() => new Set());
  const activeItems = sampleMode ? sampleItems : items;

  useEffect(() => {
    setItems(leads);
    if (leads.length > 0) setSampleMode(false);
  }, [leads]);

  useEffect(() => {
    function refreshInbox() {
      router.refresh();
      setNow(Date.now());
    }

    const id = window.setInterval(refreshInbox, INBOX_REFRESH_MS);

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        refreshInbox();
      }
    }

    window.addEventListener("focus", refreshInbox);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refreshInbox);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (sampleMode || autoSummaryStartedIds.current.size >= AUTO_VOICEMAIL_SUMMARY_LIMIT) {
      return;
    }

    const remaining = AUTO_VOICEMAIL_SUMMARY_LIMIT - autoSummaryStartedIds.current.size;
    const candidates = activeItems
      .filter((lead) => shouldAutoSummarizeVoicemail(lead, now, initiallyLoadedLeadIds.current))
      .filter((lead) => !autoSummaryStartedIds.current.has(lead.id) && !transcribingIds.has(lead.id))
      .slice(0, remaining);

    for (const lead of candidates) {
      autoSummaryStartedIds.current.add(lead.id);
      void transcribeVoicemail(lead.id);
    }
  }, [activeItems, now, sampleMode, transcribingIds]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const counts = useMemo(() => countLeads(activeItems), [activeItems]);
  const filteredItems = useMemo(
    () => filterLeads(activeItems, filter, query),
    [activeItems, filter, query],
  );
  const attentionItems = useMemo(
    () => filteredItems.filter(needsAttention),
    [filteredItems],
  );
  const normalItems = useMemo(
    () => filteredItems.filter((lead) => !needsAttention(lead)),
    [filteredItems],
  );

  const openLead = activeItems.find((lead) => lead.id === openId) ?? null;

  function updateLocalLead(id: string, updates: Partial<Lead>) {
    const setter = sampleMode ? setSampleItems : setItems;
    setter((current) => current.map((lead) => (lead.id === id ? { ...lead, ...updates } : lead)));
  }

  function updateLocalLeadsByPhone(phone: string, updates: Partial<Lead>) {
    const setter = sampleMode ? setSampleItems : setItems;
    setter((current) => current.map((lead) => (lead.phone === phone ? { ...lead, ...updates } : lead)));
  }

  function toggleLeadDetails(id: string) {
    setExpandedLeadIds((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  async function updateStatus(id: string, status: LeadStatus) {
    if (sampleMode) {
      updateLocalLead(id, { status });
      return;
    }

    const previousItems = items;
    updateLocalLead(id, { status });

    const saved = await patchLead(id, { status });
    if (!saved) setItems(previousItems);
  }

  async function updateName(id: string, name: string | null) {
    const currentLead = activeItems.find((lead) => lead.id === id);

    if (!currentLead) {
      return;
    }

    if (sampleMode) {
      updateLocalLeadsByPhone(currentLead.phone, { name });
      return;
    }

    const previousItems = items;
    updateLocalLeadsByPhone(currentLead.phone, { name });

    const saved = await patchLead(id, { name });
    if (!saved) setItems(previousItems);
  }

  async function updateBooked(id: string, booked: boolean) {
    const currentLead = activeItems.find((lead) => lead.id === id);
    const bookedAt = booked ? currentLead?.booked_at ?? new Date().toISOString() : null;
    const updates: Partial<Lead> = {
      booked_at: bookedAt,
      job_value_cents: booked ? currentLead?.job_value_cents ?? null : null,
    };

    if (sampleMode) {
      updateLocalLead(id, updates);
      return;
    }

    const previousItems = items;
    updateLocalLead(id, updates);

    const saved = await patchLead(id, {
      booked,
      jobValueCents: booked ? currentLead?.job_value_cents ?? null : null,
    });
    if (!saved) setItems(previousItems);
  }

  async function updateNotes(id: string, notes: string) {
    if (sampleMode) {
      updateLocalLead(id, { notes });
      return;
    }

    const previousItems = items;
    updateLocalLead(id, { notes });

    const saved = await patchLead(id, { notes });
    if (!saved) setItems(previousItems);
  }

  async function updateVoicemailSummary(id: string, voicemailSummary: string) {
    const normalizedSummary = voicemailSummary.trim() || null;

    if (sampleMode) {
      updateLocalLead(id, { voicemail_summary: normalizedSummary });
      return;
    }

    const previousItems = items;
    updateLocalLead(id, { voicemail_summary: normalizedSummary });

    const saved = await patchLead(id, { voicemailSummary: normalizedSummary });
    if (!saved) setItems(previousItems);
  }

  async function updateJobValue(id: string, jobValueCents: number | null) {
    if (sampleMode) {
      updateLocalLead(id, { job_value_cents: jobValueCents });
      return;
    }

    const previousItems = items;
    updateLocalLead(id, { job_value_cents: jobValueCents });

    const saved = await patchLead(id, { jobValueCents });
    if (!saved) setItems(previousItems);
  }

  async function transcribeVoicemail(id: string) {
    if (sampleMode) {
      updateLocalLead(id, {
        voicemail_transcript: "The caller needs help with a kitchen sink backup and wants service today if possible.",
        voicemail_summary: "Kitchen sink backup; wants service today if possible.",
        voicemail_transcription_status: "completed",
        voicemail_transcription_error: null,
        voicemail_transcribed_at: new Date().toISOString(),
      });
      return;
    }

    setTranscribingIds((current) => new Set(current).add(id));
    updateLocalLead(id, {
      voicemail_transcription_status: "processing",
      voicemail_transcription_error: null,
    });

    const result = await requestVoicemailSummary(id);

    if (result.ok) {
      updateLocalLead(id, {
        voicemail_transcript: result.data.transcript,
        voicemail_summary: result.data.summary,
        voicemail_transcription_status: result.data.status,
        voicemail_transcription_error: null,
        voicemail_transcribed_at: new Date().toISOString(),
      });
    } else {
      updateLocalLead(id, {
        voicemail_transcription_status: "failed",
        voicemail_transcription_error: result.error,
      });
    }

    setTranscribingIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  return (
    <>
      <header className="app-head">
        <Link className="app-head__brand app-head__brand--link" href="/">
          <div className="brand-mark"><Icon name="relay" size={18} /></div>
          <div>
            <p className="t-eyebrow" style={{ fontSize: 10 }}>Relay NW</p>
            <h1 className="t-display" style={{ fontSize: 22, margin: 0 }}>{businessName}</h1>
          </div>
          <span className="live-dot" title="Auto-refreshes every few seconds">
            <span className="live-dot__pulse" />
            <span className="live-dot__core" />
            Live
          </span>
        </Link>

        <div className="app-head__right">
          <div className="search">
            <Icon name="search" size={14} />
            <input
              ref={searchRef}
              className="search__input"
              placeholder="Search name, phone, message..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <span className="kbd">⌘K</span>
          </div>
          <button className="btn btn-ghost btn-sm app-head__refresh" type="button" onClick={() => router.refresh()} aria-label="Refresh">
            <Icon name="refresh" size={14} />
          </button>
          <button
            className={`btn btn-secondary btn-sm app-head__sample ${sampleMode ? "btn-sample-on" : ""}`}
            type="button"
            onClick={() => {
              setSampleMode((value) => !value);
              setOpenId(null);
            }}
          >
            Sample data
          </button>
          <form className="app-head__logout" action="/api/leads-logout" method="POST">
            <button className="btn btn-secondary btn-sm">Log out</button>
          </form>
        </div>
      </header>

      <section className="page-head">
        <div>
          <p className="t-eyebrow">Inbox</p>
          <h2 className="t-display page-head__title">
            {counts.actionable > 0 ? (
              <>You have <em>{counts.actionable}</em> {counts.actionable === 1 ? "lead" : "leads"} to work.</>
            ) : (
              <>Inbox is clear. Nice work.</>
            )}
          </h2>
        </div>
        <aside className="revenue-summary" aria-label="Booked value tracked">
          <span className="revenue-summary__label">Booked value tracked</span>
          <strong className="revenue-summary__amount t-display">
            {counts.bookedWithValue > 0 ? formatCurrency(counts.bookedValueCents) : "Add values"}
          </strong>
          <span className="revenue-summary__note">
            {counts.bookedWithValue > 0
              ? `${counts.bookedWithValue} ${counts.bookedWithValue === 1 ? "booked job" : "booked jobs"} counted`
              : "Enter job value when a lead books."}
          </span>
        </aside>
      </section>

      <nav className="filters clean-scroll" aria-label="Filter leads">
        {FILTERS.map((item) => {
          const count = counts[item.key];
          const active = filter === item.key;
          return (
            <button
              key={item.key}
              type="button"
              className={`filter-pill ${active ? "filter-pill--on" : ""}`}
              onClick={() => setFilter(item.key)}
              aria-pressed={active}
            >
              {item.label}
              <span className="filter-pill__count">{count}</span>
            </button>
          );
        })}
        <span className="sort-pill">
          <Icon name="clock" size={12} /> Newest first
        </span>
      </nav>

      <div className="leads-list">
        {attentionItems.length > 0 ? (
          <section className="attention-group" aria-label="Needs attention">
            <div className="attention-group__head">
              <div>
                <p className="t-eyebrow">Needs attention</p>
                <h3>Follow up manually</h3>
              </div>
              <span>{attentionItems.length} {attentionItems.length === 1 ? "lead" : "leads"}</span>
            </div>
            <p className="attention-group__note">
              Auto-text did not complete for these callers. Call or text them directly.
            </p>
            <div className="attention-group__list">
              {attentionItems.map((lead) => (
                <LeadCard
                  key={lead.id}
                  lead={lead}
                  now={now}
                  onOpen={setOpenId}
                  onStatus={updateStatus}
                  onBooked={updateBooked}
                  onJobValue={updateJobValue}
                  expanded={expandedLeadIds.has(lead.id)}
                  onToggleDetails={toggleLeadDetails}
                />
              ))}
            </div>
          </section>
        ) : null}

        {normalItems.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            now={now}
            onOpen={setOpenId}
            onStatus={updateStatus}
            onBooked={updateBooked}
            onJobValue={updateJobValue}
            expanded={expandedLeadIds.has(lead.id)}
            onToggleDetails={toggleLeadDetails}
          />
        ))}

        {filteredItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon"><Icon name="inbox" size={28} /></div>
            <h3 className="t-display" style={{ fontSize: 24, margin: "12px 0 4px" }}>
              {activeItems.length === 0 ? "No missed calls yet." : "No leads in this view."}
            </h3>
            <p style={{ color: "var(--ink-3)", margin: 0 }}>
              {activeItems.length === 0
                ? "Once someone calls and you miss it, Relay NW will save the caller, voicemail, and follow-up status here."
                : "Try another status filter or wait for new missed calls to come in."}
            </p>
          </div>
        ) : null}
      </div>

      {openLead ? (
        <LeadDrawer
          key={openLead.id}
          lead={openLead}
          onClose={() => setOpenId(null)}
          onStatus={updateStatus}
          onBooked={updateBooked}
          onName={updateName}
          onNotes={updateNotes}
          onSummary={updateVoicemailSummary}
          onJobValue={updateJobValue}
          onTranscribe={transcribeVoicemail}
          isTranscribing={transcribingIds.has(openLead.id)}
        />
      ) : null}

    </>
  );
}
