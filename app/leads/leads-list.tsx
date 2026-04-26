"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import type { Lead, LeadStatus, WebhookEvent } from "@/lib/supabase";

const STATUS_OPTIONS: LeadStatus[] = ["new", "contacted", "booked", "dead"];
const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  booked: "Booked",
  dead: "Closed",
};

type Filter = "all" | LeadStatus;

type LeadCounts = Record<Filter, number> & {
  actionable: number;
  missed: number;
  smsIssues: number;
};

type LeadPatch = {
  status?: LeadStatus;
  notes?: string | null;
};

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: "all", label: "All" },
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "booked", label: "Booked" },
  { key: "dead", label: "Closed" },
];

const QUICK_REPLIES = [
  "Thanks for reaching out. I can call you shortly.",
  "Can I come by tomorrow morning?",
  "Can you send a photo of the issue?",
  "I can get you on the schedule today.",
];

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
      source: "missed_call",
      status: "new",
      sms_status: "sent",
      sms_error: null,
      twilio_message_sid: "sample-message-1",
      sms_updated_at: new Date(now - 13 * 60_000).toISOString(),
      recording_sid: "sample-recording-1",
      recording_url: null,
      recording_duration: 18,
      recording_status: "completed",
      created_at: new Date(now - 14 * 60_000).toISOString(),
    },
    {
      id: "sample-priya",
      call_sid: null,
      name: "Priya Shah",
      phone: "+12065550187",
      message: "Water heater is making a popping noise. Flexible tomorrow morning or early afternoon.",
      notes: "",
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
      created_at: new Date(now - 52 * 60_000).toISOString(),
    },
    {
      id: "sample-eli",
      call_sid: "sample-call-2",
      name: "Eli Ramirez",
      phone: "+12065550192",
      message: "Outdoor faucet is leaking near the garage.",
      notes: "Left voicemail. Try again after 4pm.",
      source: "missed_call",
      status: "booked",
      sms_status: "sent",
      sms_error: null,
      twilio_message_sid: "sample-message-2",
      sms_updated_at: new Date(now - 3 * 60 * 60_000).toISOString(),
      recording_sid: null,
      recording_url: null,
      recording_duration: null,
      recording_status: null,
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
  return lead.sms_status === "failed" || lead.sms_status === "undelivered";
}

function countLeads(leads: Lead[]): LeadCounts {
  return {
    all: leads.length,
    new: leads.filter((lead) => lead.status === "new").length,
    actionable: leads.filter((lead) => lead.status === "new" || lead.status === "contacted").length,
    contacted: leads.filter((lead) => lead.status === "contacted").length,
    booked: leads.filter((lead) => lead.status === "booked").length,
    dead: leads.filter((lead) => lead.status === "dead").length,
    missed: leads.filter((lead) => lead.source === "missed_call").length,
    smsIssues: leads.filter(needsAttention).length,
  };
}

function countMissedCallsToday(leads: Lead[], now: number) {
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);

  return leads.filter(
    (lead) =>
      lead.source === "missed_call" &&
      new Date(lead.created_at).getTime() >= dayStart.getTime(),
  ).length;
}

function leadMatchesSearch(lead: Lead, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }

  return [lead.name, lead.phone, lead.message, lead.notes, sourceLabel(lead.source)]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
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

  return "Auto-text pending or waiting on SMS setup.";
}

function StatusPill({ status }: { status: LeadStatus }) {
  return <span className={`chip status-pill--${status}`}>{STATUS_LABELS[status]}</span>;
}

function SourceBadge({ source }: { source: Lead["source"] }) {
  return (
    <span className="chip" style={{ textTransform: "none", letterSpacing: 0, fontSize: 12 }}>
      <Icon name={source === "missed_call" ? "phoneMissed" : "inbox"} size={12} />
      {sourceLabel(source)}
    </span>
  );
}

function SmsBadge({ lead }: { lead: Lead }) {
  if (!lead.sms_status || lead.source !== "missed_call") return null;

  if (lead.sms_status === "failed" || lead.sms_status === "undelivered") {
    return <span className="chip chip-danger"><Icon name="alertTriangle" size={12} /> SMS failed</span>;
  }
  if (lead.sms_status === "delivered") {
    return <span className="chip chip-good"><Icon name="checkDouble" size={12} /> SMS delivered</span>;
  }
  if (lead.sms_status === "sent") {
    return <span className="chip chip-good"><Icon name="checkDouble" size={12} /> SMS sent</span>;
  }
  if (lead.sms_status === "skipped_opt_out") {
    return <span className="chip chip-warn"><Icon name="shield" size={12} /> Opted out</span>;
  }
  if (lead.sms_status === "skipped_recent") {
    return <span className="chip"><Icon name="clock" size={12} /> Recently texted</span>;
  }
  return <span className="chip chip-warn"><Icon name="clock" size={12} /> SMS pending</span>;
}

function VoicemailBadge({ lead }: { lead: Lead }) {
  if (!lead.recording_url && !lead.recording_sid) return null;

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

function eventPhone(event: WebhookEvent) {
  const payload = event.payload ?? {};
  const value =
    payload.From ||
    payload.To ||
    payload.Caller ||
    payload.Called;

  return typeof value === "string" ? formatPhone(value) : null;
}

function eventOutcome(event: WebhookEvent) {
  const payload = event.payload ?? {};
  const status =
    payload.DialCallStatus ||
    payload.MessageStatus ||
    payload.SmsStatus ||
    payload.RecordingStatus;

  if (typeof status === "string" && status) {
    return status;
  }

  return event.response_status >= 400 ? "request failed" : "received";
}

function eventErrorText(event: WebhookEvent) {
  return event.error?.toLowerCase() ?? "";
}

function eventNeedsReview(event: WebhookEvent) {
  const note = eventErrorText(event);

  return (
    event.response_status >= 400 ||
    note.includes("invalid") ||
    note.includes("failed") ||
    note.includes("undelivered") ||
    note.includes("no lead matched")
  );
}

function ownerVisibleEventNote(event: WebhookEvent) {
  const note = eventErrorText(event);

  if (note.includes("sms status: failed") || note.includes("sms status: undelivered")) {
    return "Auto-text failed. Follow up manually.";
  }

  if (note.includes("no lead matched")) {
    return "Relay could not attach this update to a lead.";
  }

  if (note.includes("invalid twilio signature")) {
    return "Twilio signature check failed. Check the webhook URL and app URL.";
  }

  return null;
}

function activitySummary(event: WebhookEvent) {
  const outcome = eventOutcome(event);

  if (event.source === "twilio_voice") {
    const note = ownerVisibleEventNote(event);

    if (note) {
      return {
        title: "Call reached Relay NW",
        detail: `${eventPhone(event) ? `Caller ${eventPhone(event)} reached Relay. ` : ""}${note}`,
      };
    }

    return {
      title: "Call reached Relay NW",
      detail: eventPhone(event)
        ? `Caller ${eventPhone(event)} reached the call handler.`
        : "Twilio reached the call handler.",
    };
  }

  if (event.source === "twilio_dial_status") {
    if (["no-answer", "busy", "failed", "canceled"].includes(outcome)) {
      return {
        title: "Missed call confirmed",
        detail: `The forwarded call ended as ${outcome}. Relay checked whether to send the auto-text.`,
      };
    }

    if (["answered", "completed"].includes(outcome)) {
      return {
        title: "Call was answered",
        detail: "Relay did not send a missed-call text.",
      };
    }

    return {
      title: "Call result received",
      detail: `Relay received call result: ${outcome}.`,
    };
  }

  if (event.source === "twilio_sms_status") {
    if (["failed", "undelivered"].includes(outcome)) {
      return {
        title: "Auto-text did not deliver",
        detail: "The owner should follow up manually.",
      };
    }

    if (outcome === "delivered") {
      return {
        title: "Auto-text delivered",
        detail: "The caller's carrier reported the text as delivered.",
      };
    }

    return {
      title: "Auto-text status updated",
      detail: `Current text status: ${outcome}.`,
    };
  }

  if (event.source === "twilio_inbound_sms") {
    return {
      title: "Customer text received",
      detail: eventPhone(event)
        ? `Reply came from ${eventPhone(event)}.`
        : "Relay received a customer reply.",
    };
  }

  return {
    title: "Voicemail saved",
    detail: "Relay received a voicemail recording update.",
  };
}

function activityTone(event: WebhookEvent) {
  if (eventNeedsReview(event)) return "warn";

  const outcome = eventOutcome(event);
  if (["failed", "undelivered"].includes(outcome)) return "warn";
  if (["delivered", "completed", "answered"].includes(outcome)) return "good";
  return "neutral";
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

function LeadDrawer({
  lead,
  onClose,
  onStatus,
  onNotes,
}: {
  lead: Lead;
  onClose: () => void;
  onStatus: (id: string, status: LeadStatus) => void;
  onNotes: (id: string, notes: string) => void;
}) {
  const [notes, setNotes] = useState(lead.notes ?? "");

  useEffect(() => {
    setNotes(lead.notes ?? "");
  }, [lead.id, lead.notes]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`Lead ${lead.name || lead.phone}`}>
        <header className="drawer__head">
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
            <Icon name="x" size={14} /> Close
          </button>
          <div className="drawer__head-actions">
            <a className="btn btn-secondary btn-sm" href={`tel:${lead.phone}`}>
              <Icon name="phone" size={13} /> Call
            </a>
            <button className="btn btn-ghost btn-sm" type="button" aria-label="More">
              <Icon name="more" size={16} />
            </button>
          </div>
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
            <div className="mt-3 flex flex-wrap gap-2">
              <StatusPill status={lead.status} />
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

        {lead.message ? (
          <div className="drawer__message">
            <p className="t-eyebrow">Request details</p>
            <p style={{ margin: "8px 0 0", lineHeight: 1.55 }}>{lead.message}</p>
          </div>
        ) : null}

        {(lead.recording_url || lead.recording_sid) ? (
          <div className="drawer__message voicemail-card">
            <div>
              <p className="t-eyebrow">Voicemail</p>
              <p style={{ margin: "8px 0 0", color: "var(--ink-2)" }}>
                {formatDuration(lead.recording_duration)}
              </p>
            </div>
            {lead.recording_sid ? (
              <audio className="voicemail-card__audio" controls src={`/api/recordings/${lead.recording_sid}`}>
                <a href={`/api/recordings/${lead.recording_sid}`}>Open voicemail</a>
              </audio>
            ) : lead.recording_url ? (
              <a className="btn btn-secondary btn-sm" href={lead.recording_url} target="_blank" rel="noreferrer">
                Open voicemail
              </a>
            ) : (
              <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 13 }}>
                Recording is processing in Twilio.
              </p>
            )}
          </div>
        ) : null}

        <div className="drawer__section-head">
          <p className="t-eyebrow">Follow-up</p>
          <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
            Use your phone for replies
          </span>
        </div>

        <div className="follow-up-panel">
          <div className={`follow-up-status ${lead.sms_status === "failed" ? "follow-up-status--warn" : ""}`}>
            <Icon name={lead.sms_status === "failed" ? "alertTriangle" : "message"} size={15} />
            <span>{followUpStatusText(lead)}</span>
          </div>
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
          <div className="follow-up-actions">
            <a className="btn btn-primary" href={`sms:${lead.phone}`}>
              <Icon name="message" size={14} /> Text from your phone
            </a>
            <a className="btn btn-secondary" href={`tel:${lead.phone}`}>
              <Icon name="phone" size={14} /> Call back
            </a>
          </div>
          <p className="follow-up-hint">
            Replies open your phone's messages app so follow-up stays personal and fast.
          </p>
        </div>

        <div className="drawer__notes">
          <p className="t-eyebrow" style={{ marginBottom: 8 }}>Owner notes</p>
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
}: {
  lead: Lead;
  now: number;
  onOpen: (id: string) => void;
  onStatus: (id: string, status: LeadStatus) => void;
}) {
  const attention = needsAttention(lead);

  return (
    <article
      className={`lead-card ${lead.status === "new" ? "lead-card--new" : ""} ${attention ? "lead-card--attention" : ""}`}
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
          <SourceBadge source={lead.source} />
          <SmsBadge lead={lead} />
          <VoicemailBadge lead={lead} />
        </div>
      </div>

      {lead.message ? <p className="lead-card__msg">{lead.message}</p> : null}

      {attention ? (
        <div className="lead-card__alert">
          <Icon name="alertTriangle" size={14} />
          <span>{lead.sms_error || "SMS delivery failed"} - call them directly.</span>
        </div>
      ) : null}

      <div className="lead-card__actions" onClick={(event) => event.stopPropagation()}>
        <a className="btn btn-primary btn-sm" href={`tel:${lead.phone}`}>
          <Icon name="phone" size={13} /> Call
        </a>
        <a className="btn btn-secondary btn-sm" href={`sms:${lead.phone}`}>
          <Icon name="message" size={13} /> Text
        </a>
        <StatusControl status={lead.status} onChange={(status) => onStatus(lead.id, status)} />
        <button className="btn btn-ghost btn-sm ml-auto" type="button" onClick={() => onOpen(lead.id)}>
          Open <Icon name="chevronRight" size={13} />
        </button>
      </div>
    </article>
  );
}

export function LeadsList({
  leads,
  businessName,
  webhookEvents,
}: {
  leads: Lead[];
  businessName: string;
  webhookEvents: WebhookEvent[];
}) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useState(leads);
  const [sampleItems, setSampleItems] = useState(() => createSampleLeads());
  const [sampleMode, setSampleMode] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const activeItems = sampleMode ? sampleItems : items;

  useEffect(() => {
    setItems(leads);
    if (leads.length > 0) setSampleMode(false);
  }, [leads]);

  useEffect(() => {
    const id = window.setInterval(() => router.refresh(), 30_000);
    return () => window.clearInterval(id);
  }, [router]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

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
  const missedCallsToday = useMemo(
    () => countMissedCallsToday(activeItems, now),
    [activeItems, now],
  );
  const filteredItems = useMemo(
    () => filterLeads(activeItems, filter, query),
    [activeItems, filter, query],
  );

  const openLead = activeItems.find((lead) => lead.id === openId) ?? null;

  function updateLocalLead(id: string, updates: Partial<Lead>) {
    const setter = sampleMode ? setSampleItems : setItems;
    setter((current) => current.map((lead) => (lead.id === id ? { ...lead, ...updates } : lead)));
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

  return (
    <>
      <header className="app-head">
        <Link className="app-head__brand app-head__brand--link" href="/">
          <div className="brand-mark"><Icon name="relay" size={18} /></div>
          <div>
            <p className="t-eyebrow" style={{ fontSize: 10 }}>Relay NW</p>
            <h1 className="t-display" style={{ fontSize: 22, margin: 0 }}>{businessName}</h1>
          </div>
          <span className="live-dot" title="Auto-refreshes every 30 seconds">
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
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => router.refresh()} aria-label="Refresh">
            <Icon name="refresh" size={14} />
          </button>
          <button
            className={`btn btn-secondary btn-sm ${sampleMode ? "btn-sample-on" : ""}`}
            type="button"
            onClick={() => {
              setSampleMode((value) => !value);
              setOpenId(null);
            }}
          >
            Sample data
          </button>
          <form action="/api/leads-logout" method="POST">
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
      </section>

      <div className="pulse-strip">
        <div className="pulse-cell pulse-cell--accent">
          <p className="t-eyebrow" style={{ fontSize: 10.5 }}>Needs your reply</p>
          <p className="pulse-value t-display">{counts.actionable}</p>
          <p className="pulse-sub">{counts.actionable === 1 ? "lead waiting" : "leads waiting"}</p>
        </div>
        <div className="pulse-cell pulse-cell--brand">
          <p className="t-eyebrow" style={{ fontSize: 10.5 }}>Missed calls today</p>
          <p className="pulse-value t-display">{missedCallsToday}</p>
          <p className="pulse-sub">auto-texted when eligible</p>
        </div>
        <div className="pulse-cell pulse-cell--good">
          <p className="t-eyebrow" style={{ fontSize: 10.5 }}>SMS issues</p>
          <p className="pulse-value t-display">{counts.smsIssues}</p>
          <p className="pulse-sub">{counts.smsIssues === 1 ? "needs manual follow-up" : "delivery problems"}</p>
        </div>
        <div className="pulse-cell pulse-cell--neutral">
          <p className="t-eyebrow" style={{ fontSize: 10.5 }}>Total leads</p>
          <p className="pulse-value t-display">{counts.all}</p>
          <p className="pulse-sub">{sampleMode ? "sample data" : "captured so far"}</p>
        </div>
      </div>

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
        {filteredItems.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            now={now}
            onOpen={setOpenId}
            onStatus={updateStatus}
          />
        ))}

        {filteredItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon"><Icon name="inbox" size={28} /></div>
            <h3 className="t-display" style={{ fontSize: 24, margin: "12px 0 4px" }}>Nothing here yet.</h3>
            <p style={{ color: "var(--ink-3)", margin: 0 }}>
              {filter === "all" ? "Missed calls and intake forms will land here." : "No leads match this view."}
            </p>
          </div>
        ) : null}
      </div>

      {openLead ? (
        <LeadDrawer
          lead={openLead}
          onClose={() => setOpenId(null)}
          onStatus={updateStatus}
          onNotes={updateNotes}
        />
      ) : null}

      <details className="activity-panel">
        <summary className="activity-panel__summary">
          <div>
            <p className="t-eyebrow">Activity</p>
            <h3 className="t-display" style={{ fontSize: 24, margin: "4px 0 0" }}>
              Recent call history
            </h3>
          </div>
          <p style={{ margin: 0, color: "var(--ink-3)", fontSize: 13 }}>
            Open when you need to check what Relay saw.
          </p>
        </summary>

        <div className="activity-panel__content">
          <p className="activity-panel__count">Last {webhookEvents.length} system updates</p>
          {webhookEvents.length > 0 ? (
            <ol className="activity-list">
              {webhookEvents.map((event) => {
                const summary = activitySummary(event);
                const tone = activityTone(event);

                return (
                  <li className={`activity-item activity-item--${tone}`} key={event.id}>
                    <div className="activity-item__marker" />
                    <div className="activity-item__body">
                      <div className="activity-item__top">
                        <strong>{summary.title}</strong>
                        <span>{formatRelativeTime(event.created_at, now)}</span>
                      </div>
                      <p>{summary.detail}</p>
                      {ownerVisibleEventNote(event) ? (
                        <p className="activity-item__note">{ownerVisibleEventNote(event)}</p>
                      ) : null}
                      <details className="activity-details">
                        <summary>Technical details</summary>
                        {event.error ? <p>{event.error}</p> : null}
                        <pre>{JSON.stringify(event.payload, null, 2)}</pre>
                      </details>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="empty-state empty-state--compact">
              <div className="empty-state__icon"><Icon name="inbox" size={22} /></div>
              <p style={{ color: "var(--ink-3)", margin: "8px 0 0" }}>
                Calls, texts, and voicemail updates will appear here in plain English.
              </p>
            </div>
          )}
        </div>
      </details>
    </>
  );
}
