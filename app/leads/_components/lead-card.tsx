"use client";

import { Icon } from "@/components/icon";
import type { Lead, LeadStatus } from "@/lib/supabase";
import { LEGACY_FORWARDING_MESSAGE } from "../_constants";
import { formatPhone, formatRelativeTime, getLeadNextAction, getLeadPriority, initials, isBookedLead, needsAttention, shouldShowVoicemailSummaryProgress } from "../_utils";
import { BookedBadge, PriorityBadge, SmsBadge, SourceBadge, StatusPill, VoicemailBadge } from "./badges";
import { BookedValueInput } from "./controls";
import { VoicemailAudio } from "./voicemail-audio";

export function LeadCard({
  lead,
  now,
  onOpen,
  onStatus,
  onBooked,
  onJobValue,
  onDelete,
  onRestore,
  expanded,
  onToggleDetails,
}: {
  lead: Lead;
  now: number;
  onOpen: (id: string) => void;
  onStatus: (id: string, status: LeadStatus) => void;
  onBooked: (id: string, booked: boolean) => void;
  onJobValue: (id: string, jobValueCents: number | null) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string) => void;
  expanded: boolean;
  onToggleDetails: (id: string) => void;
}) {
  const attention = needsAttention(lead);
  const booked = isBookedLead(lead);
  const trashed = Boolean(lead.deleted_at);
  const priority = getLeadPriority(lead);
  const nextAction = getLeadNextAction(lead, now);
  const hasDetails = Boolean(lead.voicemail_transcript || lead.notes || lead.recording_sid);
  const detailsVisible = hasDetails && expanded;
  const hasUsefulMessage = Boolean(lead.message && lead.message !== LEGACY_FORWARDING_MESSAGE);
  const summaryGenerating = !lead.voicemail_summary && lead.voicemail_transcription_status === "processing";
  const summaryPreparing =
    shouldShowVoicemailSummaryProgress(lead, now) && lead.voicemail_transcription_status !== "processing";
  const requestLabel = lead.voicemail_summary
    ? "What they need"
    : hasUsefulMessage
      ? "Request"
      : lead.recording_sid
        ? "Voicemail"
        : "Missed call";
  const requestText = lead.voicemail_summary
    ? lead.voicemail_summary
    : hasUsefulMessage
      ? lead.message
      : lead.recording_sid
        ? lead.voicemail_transcription_status === "failed"
          ? "Voicemail saved. Summary unavailable. Open the lead to listen."
          : "Voicemail saved. Open the lead to listen or summarize."
        : "No voicemail left. Call back while the request is still fresh.";

  return (
    <article
      className={`lead-card ${attention ? "lead-card--attention" : ""} ${
        priority.level === "fast" && lead.status === "new" ? "lead-card--fast" : ""
      } ${trashed ? "lead-card--trashed" : ""}`}
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
          {trashed ? <span className="chip chip-muted">Trash</span> : <StatusPill status={lead.status} />}
          <BookedBadge lead={lead} />
          <PriorityBadge priority={priority} />
          {lead.source === "intake_form" ? <SourceBadge source={lead.source} /> : null}
          <SmsBadge lead={lead} />
          <VoicemailBadge lead={lead} />
        </div>
      </div>

      {nextAction ? (
        <section className={`lead-card__next-action lead-card__next-action--${nextAction.tone}`}>
          <div className="lead-card__next-action-icon">
            <Icon name={nextAction.icon} size={15} />
          </div>
          <div>
            <p className="lead-card__next-action-label">{nextAction.label}</p>
            <p className="lead-card__next-action-detail">{nextAction.detail}</p>
          </div>
        </section>
      ) : null}

      <section
        className={`lead-card__request ${lead.voicemail_summary ? "lead-card__request--summary" : ""} ${
          summaryGenerating || summaryPreparing ? "lead-card__request--pending" : ""
        } ${
          priority.level === "fast" && lead.status === "new" ? "lead-card__request--fast" : ""
        }`}
        aria-label={requestLabel}
      >
        <div className="lead-card__request-label">
          <Icon name={summaryGenerating || summaryPreparing ? "sparkle" : "message"} size={13} />
          {requestLabel}
        </div>
        {summaryGenerating || summaryPreparing ? (
          <div role="status">
            <p>{summaryGenerating ? "Generating voicemail summary..." : "Preparing voicemail summary..."}</p>
            <div className="lead-card__summary-progress" aria-hidden="true" />
          </div>
        ) : (
          <p>{requestText}</p>
        )}
      </section>

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
            <VoicemailAudio className="lead-card__audio" recordingSid={lead.recording_sid} />
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
          {trashed ? (
            <button className="btn btn-primary btn-sm" type="button" onClick={() => onRestore(lead.id)}>
              Restore
            </button>
          ) : (
            <>
              <a className="btn btn-primary btn-sm" href={`tel:${lead.phone}`}>
                <Icon name="phone" size={13} /> Call back
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
            </>
          )}
        </div>
        {!trashed || hasDetails ? (
          <div className="lead-card__utility-actions">
            {!trashed ? (
              <a className="btn btn-ghost btn-sm" href={`sms:${lead.phone}`}>
                <Icon name="message" size={13} /> Text
              </a>
            ) : null}
            {hasDetails ? (
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => onToggleDetails(lead.id)}>
                {detailsVisible ? "Hide details" : "Details"}
              </button>
            ) : null}
            {!trashed ? (
              <button
                className="btn btn-danger-ghost btn-sm"
                type="button"
                onClick={() => {
                  if (window.confirm("Move this lead to Trash?")) {
                    onDelete(lead.id);
                  }
                }}
              >
                Delete
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}
