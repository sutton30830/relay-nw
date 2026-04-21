"use client";

import { useMemo, useState } from "react";
import type { Lead, LeadStatus } from "@/lib/supabase";

const STATUS_OPTIONS: LeadStatus[] = ["new", "contacted", "booked", "dead"];

function formatRelativeTime(value: string) {
  const createdAt = new Date(value).getTime();
  const diffMs = Date.now() - createdAt;
  const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));

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
  return `${diffDays}d ago`;
}

function sourceLabel(source: Lead["source"]) {
  return source.replace("_", " ");
}

export function LeadsList({ leads }: { leads: Lead[] }) {
  const [items, setItems] = useState(leads);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);
  const [savedNotesId, setSavedNotesId] = useState<string | null>(null);

  const counts = useMemo(
    () => ({
      total: items.length,
      missed: items.filter((lead) => lead.source === "missed_call").length,
      intake: items.filter((lead) => lead.source === "intake_form").length,
    }),
    [items],
  );

  async function updateStatus(id: string, status: LeadStatus) {
    const previousItems = items;
    setSavingId(id);
    setErrorId(null);
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

  function smsStatusBadge(lead: Lead) {
    if (!lead.sms_status || lead.source !== "missed_call") {
      return null;
    }

    if (lead.sms_status === "failed") {
      return (
        <span className="rounded-full bg-red-50 px-3 py-1 text-sm font-semibold text-red-800">
          SMS failed
        </span>
      );
    }

    if (lead.sms_status === "skipped_opt_out") {
      return (
        <span className="rounded-full bg-amber-50 px-3 py-1 text-sm font-semibold text-amber-800">
          opted out
        </span>
      );
    }

    return (
      <span className="rounded-full bg-[#e4f0e8] px-3 py-1 text-sm font-semibold text-[var(--good)]">
        SMS {lead.sms_status}
      </span>
    );
  }

  return (
    <>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {[
          ["Total leads", String(counts.total)],
          ["Missed calls", String(counts.missed)],
          ["Intake forms", String(counts.intake)],
        ].map(([label, value]) => (
          <div key={label} className="panel p-5">
            <p className="text-sm font-semibold text-[var(--muted)]">{label}</p>
            <p className="mt-2 text-3xl font-semibold">{value}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 grid gap-4">
        {items.map((lead) => (
          <article key={lead.id} className="panel p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[var(--muted)]">
                  {formatRelativeTime(lead.created_at)}
                </p>
                <h2 className="mt-1 text-2xl font-semibold">{lead.name || "Unknown caller"}</h2>
                <p className="mt-1 text-lg font-semibold">{lead.phone}</p>
              </div>
              <span className="rounded-full bg-[#eee9df] px-3 py-1 text-sm font-semibold">
                {sourceLabel(lead.source)}
              </span>
              {smsStatusBadge(lead)}
            </div>

            {lead.message ? (
              <p className="mt-4 rounded-md border border-[var(--line)] bg-white p-4 leading-7 text-[var(--muted)]">
                {lead.message}
              </p>
            ) : null}

            <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <label className="block">
                <span className="mb-2 block text-sm font-semibold text-[var(--muted)]">
                  Status
                </span>
                <select
                  className="field"
                  value={lead.status}
                  onChange={(event) => updateStatus(lead.id, event.target.value as LeadStatus)}
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
              <span className="mb-2 block text-sm font-semibold text-[var(--muted)]">
                Owner notes
              </span>
              <textarea
                className="field min-h-24"
                defaultValue={lead.notes ?? ""}
                maxLength={2000}
                placeholder="Example: called back, left voicemail, booked for Thursday..."
                onBlur={(event) => updateNotes(lead.id, event.currentTarget.value)}
              />
            </label>

            <div className="mt-3 min-h-6 text-sm text-[var(--muted)]">
              {savingId === lead.id ? "Saving..." : null}
              {savedNotesId === lead.id ? "Notes saved." : null}
              {errorId === lead.id ? "Could not save. Try again." : null}
              {lead.sms_status === "failed" && lead.sms_error ? `SMS error: ${lead.sms_error}` : null}
            </div>
          </article>
        ))}

        {items.length === 0 ? (
          <div className="panel p-6 text-[var(--muted)]">No leads yet.</div>
        ) : null}
      </div>
    </>
  );
}
