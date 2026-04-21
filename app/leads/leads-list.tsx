"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lead, LeadStatus } from "@/lib/supabase";

const STATUS_OPTIONS: LeadStatus[] = ["new", "contacted", "booked", "dead"];

type Filter = "all" | "attention" | LeadStatus;

const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  attention: "Needs attention",
  new: "New",
  contacted: "Contacted",
  booked: "Booked",
  dead: "Dead",
};

const FILTER_ORDER: Filter[] = ["all", "attention", "new", "contacted", "booked", "dead"];

const POLL_INTERVAL_MS = 30_000;
const TICK_INTERVAL_MS = 30_000;

function formatRelativeTime(value: string, now: number) {
  const createdAt = new Date(value).getTime();
  const diffMs = Math.max(0, now - createdAt);
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) {
    return "just now";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);

  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);

  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  return new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function sourceLabel(source: Lead["source"]) {
  return source === "missed_call" ? "missed call" : "intake form";
}

function needsAttention(lead: Lead) {
  return lead.sms_status === "failed";
}

export function LeadsList({ leads }: { leads: Lead[] }) {
  const router = useRouter();
  const [items, setItems] = useState(leads);
  const [filter, setFilter] = useState<Filter>("all");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [savedNotesId, setSavedNotesId] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  // Sync from the server when router.refresh() brings new data in.
  useEffect(() => {
    setItems(leads);
  }, [leads]);

  // Poll the server for new leads.
  useEffect(() => {
    const id = window.setInterval(() => {
      router.refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [router]);

  // Tick the clock so relative timestamps stay fresh.
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, TICK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  const counts = useMemo(() => {
    return {
      all: items.length,
      attention: items.filter(needsAttention).length,
      new: items.filter((lead) => lead.status === "new").length,
      contacted: items.filter((lead) => lead.status === "contacted").length,
      booked: items.filter((lead) => lead.status === "booked").length,
      dead: items.filter((lead) => lead.status === "dead").length,
      missed: items.filter((lead) => lead.source === "missed_call").length,
      intake: items.filter((lead) => lead.source === "intake_form").length,
    };
  }, [items]);

  const filteredItems = useMemo(() => {
    switch (filter) {
      case "all":
        return items;
      case "attention":
        return items.filter(needsAttention);
      default:
        return items.filter((lead) => lead.status === filter);
    }
  }, [items, filter]);

  async function updateStatus(id: string, status: LeadStatus) {
    const previousItems = items;
    setSavingId(id);
    setErrorId(null);
    setSavedNotesId(null);
    setItems((current) =>
      current.map((lead) => (lead.id === id ? { ...lead, status } : lead)),
    );

    const response = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status }),
    });

    if (!response.ok) {
      setItems(previousItems);
      setErrorId(id);
    }

    setSavingId(null);
  }

  async function updateNotes(id: string, notes: string) {
    const previousItems = items;
    setSavingId(id);
    setErrorId(null);
    setSavedNotesId(null);
    setItems((current) =>
      current.map((lead) => (lead.id === id ? { ...lead, notes } : lead)),
    );

    const response = await fetch(`/api/leads/${id}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ notes }),
    });

    if (!response.ok) {
      setItems(previousItems);
      setErrorId(id);
    } else {
      setSavedNotesId(id);
      window.setTimeout(() => setSavedNotesId(null), 1800);
    }

    setSavingId(null);
  }

  function renderStatusBadge(status: LeadStatus) {
    return <span className={`status-pill status-pill--${status}`}>{status}</span>;
  }

  function renderSourceBadge(source: Lead["source"]) {
    return <span className="source-badge">{sourceLabel(source)}</span>;
  }

  function renderSmsBadge(lead: Lead) {
    if (!lead.sms_status || lead.source !== "missed_call") {
      return null;
    }

    if (lead.sms_status === "failed") {
      return <span className="sms-badge sms-badge--failed">SMS failed</span>;
    }

    if (lead.sms_status === "skipped_opt_out") {
      return <span className="sms-badge sms-badge--optout">opted out</span>;
    }

    if (lead.sms_status === "skipped_recent") {
      return <span className="sms-badge sms-badge--skipped">recently texted</span>;
    }

    if (lead.sms_status === "sent") {
      return <span className="sms-badge sms-badge--sent">SMS sent</span>;
    }

    return <span className="sms-badge sms-badge--pending">SMS {lead.sms_status}</span>;
  }

  return (
    <>
      <nav
        aria-label="Filter leads"
        className="scroll-row mt-6 flex gap-2 overflow-x-auto pb-1"
      >
        {FILTER_ORDER.map((key) => {
          const count = counts[key];
          const isActive = filter === key;
          const isAttention = key === "attention";

          if (isAttention && count === 0) {
            return null;
          }

          return (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={isActive}
              className={[
                "filter-chip",
                isActive ? "filter-chip--active" : "",
                isAttention ? "filter-chip--attention" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <span>{FILTER_LABELS[key]}</span>
              <span className="filter-chip__count">{count}</span>
            </button>
          );
        })}
      </nav>

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <div className="panel p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Total leads
          </p>
          <p className="mt-1 text-3xl font-semibold">{counts.all}</p>
        </div>
        <div className="panel p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Missed calls
          </p>
          <p className="mt-1 text-3xl font-semibold">{counts.missed}</p>
        </div>
        <div className="panel p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
            Intake forms
          </p>
          <p className="mt-1 text-3xl font-semibold">{counts.intake}</p>
        </div>
      </div>

      <div className="mt-6 grid gap-4">
        {filteredItems.map((lead) => {
          const attention = needsAttention(lead);
          const isNew = lead.status === "new";

          return (
            <article
              key={lead.id}
              className={[
                "lead-card panel p-5 sm:p-6",
                isNew ? "lead-card--new" : "",
                attention ? "lead-card--attention" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                    {formatRelativeTime(lead.created_at, now)}
                  </p>
                  <h2 className="mt-1 break-words text-2xl font-semibold">
                    {lead.name || "Unknown caller"}
                  </h2>
                  <a
                    href={`tel:${lead.phone}`}
                    className="mt-1 inline-block text-lg font-semibold text-[var(--brand)] underline-offset-4 hover:underline"
                  >
                    {lead.phone}
                  </a>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {renderStatusBadge(lead.status)}
                  {renderSourceBadge(lead.source)}
                  {renderSmsBadge(lead)}
                </div>
              </div>

              {lead.message ? (
                <p className="mt-4 rounded-md border border-[var(--line)] bg-white p-4 leading-7 text-[var(--foreground)]">
                  {lead.message}
                </p>
              ) : null}

              <div className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr_1fr] sm:items-end">
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                    Status
                  </span>
                  <select
                    className="field"
                    value={lead.status}
                    onChange={(event) =>
                      updateStatus(lead.id, event.target.value as LeadStatus)
                    }
                  >
                    {STATUS_OPTIONS.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </label>

                <a className="button-primary" href={`tel:${lead.phone}`}>
                  Call
                </a>
                <a className="button-secondary" href={`sms:${lead.phone}`}>
                  Text
                </a>
              </div>

              <label className="mt-4 block">
                <span className="mb-2 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
                  <span>Owner notes</span>
                  <span className="text-[var(--muted)]/70 text-[10px] font-normal normal-case tracking-normal">
                    Saves when you tap outside
                  </span>
                </span>
                <textarea
                  className="field min-h-24"
                  defaultValue={lead.notes ?? ""}
                  maxLength={2000}
                  placeholder="Example: called back, left voicemail, booked for Thursday..."
                  onBlur={(event) =>
                    updateNotes(lead.id, event.currentTarget.value)
                  }
                />
              </label>

              <div className="mt-3 min-h-6 text-sm text-[var(--muted)]">
                {savingId === lead.id ? "Saving..." : null}
                {savedNotesId === lead.id ? "Notes saved." : null}
                {errorId === lead.id ? "Could not save. Try again." : null}
                {lead.sms_status === "failed" && lead.sms_error
                  ? `SMS error: ${lead.sms_error}`
                  : null}
              </div>
            </article>
          );
        })}

        {filteredItems.length === 0 ? (
          <div className="panel p-6 text-center text-[var(--muted)]">
            {filter === "all"
              ? "No leads yet. Missed calls and intake submissions will show up here."
              : `No ${FILTER_LABELS[filter].toLowerCase()} leads.`}
          </div>
        ) : null}
      </div>
    </>
  );
}
