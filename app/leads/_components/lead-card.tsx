"use client";

import Link from "next/link";
import { Icon } from "@/components/icon";
import type { Lead, LeadStatus } from "@/lib/supabase";
import { hasUsableVoicemail } from "@/lib/voicemail-quality";
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

function smsAlertText(error: string | null) {
  const normalized = error?.trim();
  if (!normalized) return "SMS delivery failed. Call them directly.";

  if (/^\d{4,6}$/.test(normalized)) {
    return "SMS delivery failed. Call them directly.";
  }

  return `${normalized} Call them directly.`;
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
  const hasVoicemail = hasUsableVoicemail(lead.recording_sid, lead.recording_duration);
  const summaryGenerating =
    hasVoicemail && !lead.voicemail_summary && lead.voicemail_transcription_status === "processing";
  const summaryPreparing =
    shouldShowVoicemailSummaryProgress(lead, now) && lead.voicemail_transcription_status !== "processing";
  const noSpeechDetected =
    lead.voicemail_transcription_error?.includes("No clear spoken message was detected") ?? false;
  const requestLabel = hasVoicemail && lead.voicemail_summary
    ? "What they need"
    : hasUsefulMessage
      ? lead.source === "intake_form"
        ? "Setup request"
        : "Request"
      : hasVoicemail
        ? "Voicemail"
        : "Missed call";
  const requestText = hasVoicemail && lead.voicemail_summary
    ? lead.voicemail_summary
    : setupSummary
      ? setupSummary
    : hasUsefulMessage
      ? lead.message
      : hasVoicemail
        ? lead.voicemail_transcription_status === "failed"
          ? noSpeechDetected
            ? "Voicemail saved, but no clear spoken message was detected. Open the lead to listen."
            : "Voicemail saved. Summary unavailable. Open the lead to listen."
          : lead.voicemail_transcript
            ? "No summary available. Open the lead to review the transcript or listen."
            : "Voicemail saved. Open the lead to listen or summarize."
        : "No voicemail left. Call back while the request is still fresh.";
  const statusLabel = trashed ? "Trash" : STATUS_LABELS[lead.status];
  const statusTone = trashed ? "trash" : lead.status;
  const smsMeta = smsMetaText(lead, now);
  const headerMeta = [
    { text: formatPhone(lead.phone), className: "t-mono" },
    { text: formatRelativeTime(lead.created_at, now) },
    callCount > 1 ? { text: `${callCount} calls`, className: "lead-card__meta-secondary" } : null,
  ].filter((item): item is { text: string; className?: string } => Boolean(item));
  const quietMeta = [
    booked && lead.job_value_cents
      ? { text: `${formatCurrency(lead.job_value_cents)} booked`, mobileEssential: false }
      : null,
    lead.source === "intake_form"
      ? { text: sourceLabel(lead.source), mobileEssential: false }
      : null,
    smsMeta
      ? {
          text: smsMeta,
          mobileEssential:
            smsMeta.startsWith("SMS failed") ||
            smsMeta.startsWith("SMS off") ||
            smsMeta.startsWith("SMS skipped: opted out"),
        }
      : null,
    lead.recording_sid ? { text: "Voicemail", mobileEssential: false } : null,
  ].filter((item): item is { text: string; mobileEssential: boolean } => Boolean(item));
  const hasMobileEssentialFact = quietMeta.some((item) => item.mobileEssential);
  const showPriorityCue = !trashed && priority.level !== "normal";
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
            <div className="lead-card__title-row">
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
              <span className={`lead-card__status-pill lead-card__status-pill--${statusTone}`}>{statusLabel}</span>
            </div>
            <div className="lead-card__meta">
              {headerMeta.map((item, index) => (
                <span key={`${item.text}-${index}`} className={item.className}>
                  {item.text}
                </span>
              ))}
            </div>
          </div>
        </div>

        {quietMeta.length > 0 ? (
          <div className={`lead-card__facts ${hasMobileEssentialFact ? "lead-card__facts--has-mobile-essential" : ""}`}>
            {quietMeta.map((item, index) => (
              <span
                key={`${item.text}-${index}`}
                className={`${
                  item.text.startsWith("SMS failed") || item.text.startsWith("SMS off")
                    ? "lead-card__fact--warn"
                    : ""
                } ${item.mobileEssential ? "lead-card__fact--essential" : "lead-card__fact--secondary"}`.trim()}
              >
                {item.text}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {showPriorityCue ? (
        <div className="lead-card__cue-row">
          <span className={`lead-card__cue lead-card__cue--${priority.level}`}>
            <Icon name={priority.level === "fast" ? "alertTriangle" : "clock"} size={13} />
            {priority.label}
            {priority.reason ? <span className="lead-card__cue-reason">· {priority.reason}</span> : null}
          </span>
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
      {hasVoicemail && lead.recording_sid ? (
        <div className="lead-card__voicemail" onClick={(event) => event.stopPropagation()}>
          <VoicemailPlayer providerRecordingId={lead.recording_sid} fallbackDuration={lead.recording_duration} />
        </div>
      ) : null}

      {attention ? (
        <div className="lead-card__alert">
          <Icon name="alertTriangle" size={14} />
          <span>{smsAlertText(lead.sms_error)}</span>
        </div>
      ) : null}

      {booked ? (
        <div className="lead-card__value" onClick={(event) => event.stopPropagation()}>
          <span className="lead-card__value-label">
            <Icon name="star" size={13} />
            {lead.job_value_cents ? "Booked value" : "Add booked value"}
          </span>
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
                  label: booked ? "Mark as Unbooked" : "Mark as Booked",
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
