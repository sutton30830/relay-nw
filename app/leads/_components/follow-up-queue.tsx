"use client";

import { Icon } from "@/components/icon";
import type { Lead, LeadStatus } from "@/lib/supabase";
import { formatPhone, formatRelativeTime, getFollowUpCue, getFollowUpReason, getLeadPriority, initials, needsAttention } from "../_utils";

export function FollowUpQueue({
  leads,
  now,
  onOpen,
  onStatus,
  onBooked,
}: {
  leads: Lead[];
  now: number;
  onOpen: (id: string) => void;
  onStatus: (id: string, status: LeadStatus) => void;
  onBooked: (id: string, booked: boolean) => void;
}) {
  if (leads.length === 0) return null;

  return (
    <section className="follow-up-queue" aria-label="Call these leads first">
      <div className="follow-up-queue__head">
        <div>
          <p className="t-eyebrow">Call these first</p>
          <h3 className="t-display">Best chances to recover work.</h3>
        </div>
        <span>{leads.length} {leads.length === 1 ? "lead" : "leads"}</span>
      </div>

      <div className="follow-up-queue__list">
        {leads.map((lead) => {
          const priority = getLeadPriority(lead);
          const urgent = needsAttention(lead) || priority.level === "fast";
          const cue = getFollowUpCue(lead);

          return (
            <article
              key={lead.id}
              className={`follow-up-item ${urgent ? "follow-up-item--urgent" : ""}`}
            >
              <div className="follow-up-item__main">
                <div className="lead-card__avatar">{initials(lead) ?? <Icon name="user" size={14} />}</div>
                <div>
                  <div className="follow-up-item__title">
                    <h4>{lead.name || "Unknown caller"}</h4>
                    <span className={`follow-up-cue follow-up-cue--${cue.tone}`}>{cue.label}</span>
                  </div>
                  <p className="follow-up-item__meta">
                    <span className="t-mono">{formatPhone(lead.phone)}</span>
                    <span>·</span>
                    <span>{formatRelativeTime(lead.created_at, now)}</span>
                  </p>
                  <p className="follow-up-item__reason">{getFollowUpReason(lead)}</p>
                </div>
              </div>

              <div className="follow-up-item__actions">
                <a className="btn btn-primary btn-sm" href={`tel:${lead.phone}`}>
                  <Icon name="phone" size={14} /> Call
                </a>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => onStatus(lead.id, "contacted")}>
                  Mark contacted
                </button>
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => onBooked(lead.id, true)}>
                  Mark booked
                </button>
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => onOpen(lead.id)}>
                  Open <Icon name="arrowRight" size={14} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
