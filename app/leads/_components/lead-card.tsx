"use client";

import Link from "next/link";
import { Icon } from "@/components/icon";
import type { Lead, LeadStatus } from "@/lib/supabase";
import { LEGACY_FORWARDING_MESSAGE, STATUS_LABELS, STATUS_OPTIONS } from "../_constants";
import { formatCurrency, formatPhone, formatRelativeTime, getLeadPriority, initials, isBookedLead, needsAttention, parseSetupRequestMessage, setupRequestSummary, shouldShowVoicemailSummaryProgress, sourceLabel } from "../_utils";
import { BookedValueInput } from "./controls";
import { OverflowMenu } from "./overflow-menu";
import { VoicemailPlayer } from "./voicemail-player";

function smsMetaText(lead: Lead, now: number) {
  if (!lead.sms_status || lead.source !== "missed_call") return null;

  const updated = lead.sms_updated_at ? ` · ${formatRelativeTime(lead.sms_updated_at, now)}` : "";

  if (lead.sms_status === "failed" || lead.sms_status === "undelivered") return `SMS failed${updated}`;
  if (lead.sms_status === "delivered") return `SMS delivered${updated}`;
  if (lead.sms_status === "sent") return `SMS sent${updated}`;
  if (lead.sms_status === "queued" || lead.sms_status === "sending" || lead.sms_status === "pending") {
    return `SMS ${lead.sms_status}${updated}`;
  }
  if (lead.sms_status === "skipped_opt_out") return `SMS skipped: opted out${updated}`;
  if (lead.sms_status === "skipped_recent") return `SMS skipped: recent text${updated}`;
  if (lead.sms_status === "skipped_disabled") return `SMS off${updated}`;

  return `SMS ${lead.sms_status}${updated}`;
}

export function LeadCard({
  lead,
  now,
  callCount = 1,
  href,
  isOpening = false,
  onOpen,
  onPrefetch,
  onStatus,
  onBooked,
  onJobValue,
  onDelete,
  onRestore,
}: {
  lead: Lead;
  now: number;
  callCount?: number;
  // When set, the card is a real link to the conversation page (keyboard,
  // middle-click, prefetch). Without it (sample leads), the name is a button
  // that calls onOpen to open the in-memory drawer instead.
  href?: string;
  isOpening?: boolean;
  onOpen: (id: string) => void;
  onPrefetch?: (id: string) => void;
  onStatus: (id: string, status: LeadStatus) => void;
  onBooked: (id: string, booked: boolean) => void;
  onJobValue: (id: string, jobValueCents: number | null) => void;
  onDelete: (id: string) => void;
  onRestore: (id: string, status: LeadStatus) => void;
}) {
  const attention = needsAttention(lead);
  const booked = isBookedLead(lead);
  const trashed = Boolean(lead.deleted_at);
  const priority = getLeadPriority(lead);
  const hasUsefulMessage = Boolean(lead.message && lead.message !== LEGACY_FORWARDING_MESSAGE);
  const setupRequestFields = lead.source === "intake_form" ? parseSetupRequestMessage(lead.message) : [];
  const setupSummary = setupRequestSummary(setupRequestFields);
  const summaryGenerating = !lead.voicemail_summary && lead.voicemail_transcription_status === "processing";
  const summaryPreparing =
    shouldShowVoicemailSummaryProgress(lead, now) && lead.voicemail_transcription_status !== "processing";
  const requestLabel = lead.voicemail_summary
    ? "What they need"
    : hasUsefulMessage
      ? lead.source === "intake_form"
        ? "Setup request"
        : "Request"
      : lead.recording_sid
        ? "Voicemail"
        : "Missed call";
  const requestText = lead.voicemail_summary
    ? lead.voicemail_summary
    : setupSummary
      ? setupSummary
    : hasUsefulMessage
      ? lead.message
      : lead.recording_sid
        ? lead.voicemail_transcription_status === "failed"
          ? "Voicemail saved. Summary unavailable. Open the lead to listen."
          : lead.voicemail_transcript
            ? "No summary — the voicemail didn't say what they need. Open the lead to listen."
            : "Voicemail saved. Open the lead to listen or summarize."
        : "No voicemail left. Call back while the request is still fresh.";
  const headerMeta = [
    formatPhone(lead.phone),
    formatRelativeTime(lead.created_at, now),
    trashed ? "Trash" : STATUS_LABELS[lead.status],
    callCount > 1 ? `${callCount} calls` : null,
  ].filter(Boolean);
  const quietMeta = [
    booked ? (lead.job_value_cents ? `${formatCurrency(lead.job_value_cents)} booked` : "Booked value missing") : null,
    lead.source === "intake_form" ? sourceLabel(lead.source) : null,
    smsMetaText(lead, now),
    lead.recording_sid ? "Voicemail" : null,
  ].filter(Boolean);
  const showPriorityCue = !trashed && priority.level !== "normal";
  const showBookedValueNudge = booked && !lead.job_value_cents;
  const categoryActions = STATUS_OPTIONS
    .filter((status) => status !== lead.status)
    .map((status) => ({
      label: `Move to ${STATUS_LABELS[status]}`,
      onSelect: () => onStatus(lead.id, status),
    }));

  return (
    <article
      className={`lead-card ${attention ? "lead-card--attention" : ""} ${
        priority.level === "fast" && !trashed ? "lead-card--fast" : ""
      } ${trashed ? "lead-card--trashed" : ""} ${isOpening ? "lead-card--opening" : ""}`}
      aria-busy={isOpening}
    >
      <div className="lead-card__head">
        <div className="lead-card__id">
          <div className="lead-card__avatar">{initials(lead) ?? <Icon name="user" size={14} />}</div>
          <div style={{ minWidth: 0 }}>
            {/* The name is the card's primary link and its ::after stretches to
                cover the whole card, so a click (or Enter) anywhere opens the
                lead while inner controls stay clickable via a higher z-index. */}
            <h3 className="lead-card__name">
              {href ? (
                <Link
                  href={href}
                  className="lead-card__name-link"
                  onClick={() => onOpen(lead.id)}
                  onFocus={() => onPrefetch?.(lead.id)}
                  onMouseEnter={() => onPrefetch?.(lead.id)}
                  onTouchStart={() => onPrefetch?.(lead.id)}
                >
                  <span className="lead-card__name-text">{lead.name || "Unknown caller"}</span>
                </Link>
              ) : (
                <button
                  type="button"
                  className="lead-card__name-link"
                  onClick={() => onOpen(lead.id)}
                  onFocus={() => onPrefetch?.(lead.id)}
                  onMouseEnter={() => onPrefetch?.(lead.id)}
                  onTouchStart={() => onPrefetch?.(lead.id)}
                >
                  <span className="lead-card__name-text">{lead.name || "Unknown caller"}</span>
                </button>
              )}
            </h3>
            <div className="lead-card__meta">
              {headerMeta.map((item, index) => (
                <span key={`${item}-${index}`} className={index === 0 ? "t-mono" : undefined}>
                  {item}
                </span>
              ))}
            </div>
          </div>
        </div>

        {quietMeta.length > 0 ? (
          <div className="lead-card__facts">
            {quietMeta.map((item, index) => (
              <span
                key={`${item}-${index}`}
                className={String(item).startsWith("SMS failed") || String(item).startsWith("SMS off") ? "lead-card__fact--warn" : ""}
              >
                {item}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {showPriorityCue || showBookedValueNudge ? (
        <div className="lead-card__cue-row">
          {showPriorityCue ? (
            <span className={`lead-card__cue lead-card__cue--${priority.level}`}>
              <Icon name={priority.level === "fast" ? "alertTriangle" : "clock"} size={13} />
              {priority.label}
              {priority.reason ? <span className="lead-card__cue-reason">· {priority.reason}</span> : null}
            </span>
          ) : null}
          {showBookedValueNudge ? (
            <span className="lead-card__cue lead-card__cue--good">
              <Icon name="star" size={13} />
              Booked value missing
            </span>
          ) : null}
        </div>
      ) : null}

      <section
        className={`lead-card__request ${lead.voicemail_summary ? "lead-card__request--summary" : ""} ${
          summaryGenerating || summaryPreparing ? "lead-card__request--pending" : ""
        } ${
          priority.level === "fast" && !trashed ? "lead-card__request--fast" : ""
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

      {/* Play the voicemail straight from the inbox — the core listen→call-back
          loop shouldn't need a click into the lead. Lazy (loads on play), so a
          full inbox doesn't fetch every recording. */}
      {lead.recording_sid ? (
        <div className="lead-card__voicemail" onClick={(event) => event.stopPropagation()}>
          <VoicemailPlayer recordingSid={lead.recording_sid} fallbackDuration={lead.recording_duration} />
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

      <div className="lead-card__actions" onClick={(event) => event.stopPropagation()}>
        <div className="lead-card__primary-actions">
          {trashed ? (
            // Restore always lets the owner say where the lead goes, so it never
            // silently reappears in an unexpected tab.
            <OverflowMenu
              trigger={<>Restore&hellip;</>}
              triggerClassName="btn btn-primary btn-sm"
              items={STATUS_OPTIONS.map((status) => ({
                label: `Restore as ${STATUS_LABELS[status]}`,
                onSelect: () => onRestore(lead.id, status),
              }))}
            />
          ) : (
            <a className="btn btn-primary btn-sm" href={`tel:${lead.phone}`}>
              <Icon name="phone" size={13} /> Call back
            </a>
          )}
        </div>
        {!trashed ? (
          <div className="lead-card__utility-actions">
            <a className="btn btn-ghost btn-sm" href={`sms:${lead.phone}`}>
              <Icon name="message" size={13} /> Text
            </a>
            {/* The workflow menu is a core owner action, so label it instead of
                hiding category/booked/trash changes behind anonymous dots. */}
            <OverflowMenu
              trigger={<>Status</>}
              triggerAriaLabel="Change lead status"
              items={[
                ...categoryActions,
                {
                  label: booked ? "Mark as unbooked" : "Mark as booked",
                  onSelect: () => onBooked(lead.id, !booked),
                },
                { label: "Move to Trash", danger: true, onSelect: () => onDelete(lead.id) },
              ]}
            />
          </div>
        ) : null}
      </div>
      {isOpening ? (
        <div className="lead-card__opening" role="status">
          <Icon name="sparkle" size={13} />
          Opening conversation...
        </div>
      ) : null}
    </article>
  );
}
