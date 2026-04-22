"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import type { Lead, LeadStatus } from "@/lib/supabase";

const STATUS_OPTIONS: LeadStatus[] = ["new", "contacted", "booked", "dead"];
const STATUS_LABELS: Record<LeadStatus, string> = {
  new: "New",
  contacted: "Contacted",
  booked: "Booked",
  dead: "Dead",
};

type Filter = "all" | "attention" | LeadStatus;

const FILTERS: Array<{ key: Filter; label: string; danger?: boolean; hideIfEmpty?: boolean }> = [
  { key: "all", label: "All" },
  { key: "attention", label: "Needs attention", danger: true, hideIfEmpty: true },
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "booked", label: "Booked" },
  { key: "dead", label: "Dead" },
];

const QUICK_REPLIES = [
  "On my way - ETA 30 min.",
  "Can I come by tomorrow morning?",
  "Minimum service call is $95 - still good?",
  "I'll send a quote by end of day.",
];

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
  return lead.sms_status === "failed";
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

  if (lead.sms_status === "failed") {
    return <span className="chip chip-danger"><Icon name="alertTriangle" size={12} /> SMS failed</span>;
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
  now,
  twilioNumber,
  onClose,
  onStatus,
  onNotes,
}: {
  lead: Lead;
  now: number;
  twilioNumber: string;
  onClose: () => void;
  onStatus: (id: string, status: LeadStatus) => void;
  onNotes: (id: string, notes: string) => void;
}) {
  const [reply, setReply] = useState("");
  const [notes, setNotes] = useState(lead.notes ?? "");

  useEffect(() => {
    setReply("");
    setNotes(lead.notes ?? "");
  }, [lead.id, lead.notes]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const autoMessage =
    lead.source === "missed_call" && lead.sms_status === "sent"
      ? "Hi, sorry we missed your call. Please fill out the intake form or book a time."
      : null;

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

        <div className="drawer__section-head">
          <p className="t-eyebrow">SMS thread</p>
          <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
            {autoMessage ? "1 auto message" : "No stored replies yet"}
          </span>
        </div>

        <div className="thread clean-scroll">
          {autoMessage ? (
            <>
              <div className="thread__day"><span>{formatRelativeTime(lead.created_at, now)}</span></div>
              <div className="bubble-row bubble-row--out">
                <div className="bubble bubble--out">
                  <p className="bubble__tag"><Icon name="checkDouble" size={10} /> Auto-sent by Relay</p>
                  <p style={{ margin: 0 }}>{autoMessage}</p>
                  <p className="bubble__time">sent</p>
                </div>
              </div>
            </>
          ) : (
            <div className="thread__empty">
              <Icon name="message" size={20} />
              <p>No SMS thread yet.</p>
              <p style={{ fontSize: 13, color: "var(--ink-4)" }}>
                Customer replies are logged by the SMS webhook; full thread storage is next.
              </p>
            </div>
          )}
        </div>

        <div className="thread-composer">
          <div className="thread-composer__quick clean-scroll">
            {QUICK_REPLIES.map((template) => (
              <button key={template} className="quick-reply" type="button" onClick={() => setReply(template)}>
                {template}
              </button>
            ))}
          </div>
          <div className="thread-composer__input">
            <textarea
              className="field"
              placeholder={`Prepare a text to ${lead.name?.split(" ")[0] || "this lead"}...`}
              rows={2}
              value={reply}
              onChange={(event) => setReply(event.target.value)}
            />
            <a className="btn btn-primary" href={`sms:${lead.phone}${reply ? `?&body=${encodeURIComponent(reply)}` : ""}`}>
              <Icon name="send" size={14} /> Text
            </a>
          </div>
          <p className="thread-composer__hint">
            Opens your device SMS app. Twilio conversation sending is a follow-up backend upgrade.
            Relay number: <span className="t-mono">{twilioNumber}</span>.
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

export function LeadsList({
  leads,
  businessName,
  twilioNumber,
}: {
  leads: Lead[];
  businessName: string;
  twilioNumber: string;
}) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useState(leads);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setItems(leads);
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

  const counts = useMemo(() => ({
    all: items.length,
    attention: items.filter(needsAttention).length,
    new: items.filter((lead) => lead.status === "new").length,
    contacted: items.filter((lead) => lead.status === "contacted").length,
    booked: items.filter((lead) => lead.status === "booked").length,
    dead: items.filter((lead) => lead.status === "dead").length,
    missed: items.filter((lead) => lead.source === "missed_call").length,
    replied: 0,
  }), [items]);

  const todays = useMemo(() => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    return items.filter((lead) => new Date(lead.created_at).getTime() >= dayStart.getTime());
  }, [items, now]);

  const filteredItems = useMemo(() => {
    let list = items;
    if (filter === "attention") list = list.filter(needsAttention);
    else if (filter !== "all") list = list.filter((lead) => lead.status === filter);

    if (query.trim()) {
      const needle = query.trim().toLowerCase();
      list = list.filter((lead) =>
        [lead.name, lead.phone, lead.message, lead.notes, sourceLabel(lead.source)]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle)),
      );
    }

    return list;
  }, [items, filter, query]);

  const openLead = items.find((lead) => lead.id === openId) ?? null;

  async function updateStatus(id: string, status: LeadStatus) {
    const previousItems = items;
    setItems((current) => current.map((lead) => (lead.id === id ? { ...lead, status } : lead)));

    const response = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });

    if (!response.ok) setItems(previousItems);
  }

  async function updateNotes(id: string, notes: string) {
    const previousItems = items;
    setItems((current) => current.map((lead) => (lead.id === id ? { ...lead, notes } : lead)));

    const response = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes }),
    });

    if (!response.ok) setItems(previousItems);
  }

  return (
    <>
      <header className="app-head">
        <div className="app-head__brand">
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
        </div>

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
          <form action="/api/leads-logout" method="POST">
            <button className="btn btn-secondary btn-sm">Log out</button>
          </form>
        </div>
      </header>

      <section className="page-head">
        <div>
          <p className="t-eyebrow">Inbox</p>
          <h2 className="t-display page-head__title">
            {counts.new > 0 ? (
              <>You have <em>{counts.new}</em> new {counts.new === 1 ? "lead" : "leads"} to work.</>
            ) : (
              <>Inbox is clear. Nice work.</>
            )}
          </h2>
        </div>
      </section>

      <div className="pulse-strip">
        <div className="pulse-cell pulse-cell--accent">
          <p className="t-eyebrow" style={{ fontSize: 10.5 }}>Needs your reply</p>
          <p className="pulse-value t-display">{counts.new}</p>
          <p className="pulse-sub">{counts.new === 1 ? "lead waiting" : "leads waiting"}</p>
        </div>
        <div className="pulse-cell pulse-cell--brand">
          <p className="t-eyebrow" style={{ fontSize: 10.5 }}>Missed calls today</p>
          <p className="pulse-value t-display">{todays.filter((lead) => lead.source === "missed_call").length}</p>
          <p className="pulse-sub">auto-texted when eligible</p>
        </div>
        <div className="pulse-cell pulse-cell--good">
          <p className="t-eyebrow" style={{ fontSize: 10.5 }}>Customers replied</p>
          <p className="pulse-value t-display">{counts.replied}</p>
          <p className="pulse-sub">thread storage next</p>
        </div>
        <div className="pulse-cell">
          <p className="t-eyebrow" style={{ fontSize: 10.5 }}>Total leads</p>
          <p className="pulse-value t-display">{counts.all}</p>
          <p className="pulse-sub">newest first</p>
        </div>
      </div>

      <nav className="filters clean-scroll" aria-label="Filter leads">
        {FILTERS.map((item) => {
          const count = counts[item.key];
          if (item.hideIfEmpty && !count) return null;
          const active = filter === item.key;
          return (
            <button
              key={item.key}
              type="button"
              className={`filter-pill ${active ? "filter-pill--on" : ""} ${item.danger ? "filter-pill--danger" : ""}`}
              onClick={() => setFilter(item.key)}
              aria-pressed={active}
            >
              {item.danger ? <Icon name="alertTriangle" size={12} /> : null}
              {item.label}
              <span className="filter-pill__count">{count}</span>
            </button>
          );
        })}
      </nav>

      <div className="leads-list">
        {filteredItems.map((lead) => {
          const attention = needsAttention(lead);
          return (
            <article
              key={lead.id}
              className={`lead-card ${lead.status === "new" ? "lead-card--new" : ""} ${attention ? "lead-card--attention" : ""}`}
              onClick={() => setOpenId(lead.id)}
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
                <StatusControl status={lead.status} onChange={(status) => updateStatus(lead.id, status)} />
                <button className="btn btn-ghost btn-sm ml-auto" type="button" onClick={() => setOpenId(lead.id)}>
                  Open <Icon name="chevronRight" size={13} />
                </button>
              </div>
            </article>
          );
        })}

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
          now={now}
          twilioNumber={twilioNumber}
          onClose={() => setOpenId(null)}
          onStatus={updateStatus}
          onNotes={updateNotes}
        />
      ) : null}
    </>
  );
}
