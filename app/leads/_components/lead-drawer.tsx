"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import type { Lead, LeadStatus, ReplyPriorityOverride } from "@/lib/supabase";
import { LEGACY_FORWARDING_MESSAGE, QUICK_REPLIES } from "../_constants";
import { followUpStatusText, formatDuration, formatPhone, getLeadPriority, initials, isBookedLead } from "../_utils";
import { BookedBadge, PriorityBadge, SmsBadge, SourceBadge, StatusPill, VoicemailBadge } from "./badges";
import { BookedToggle, BookedValueInput, PriorityControl, StatusControl } from "./controls";
import { VoicemailAudio } from "./voicemail-audio";

export function LeadDrawer({
  lead,
  onClose,
  onStatus,
  onBooked,
  onName,
  onNotes,
  onSummary,
  onJobValue,
  onPriority,
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
  onPriority: (id: string, priority: ReplyPriorityOverride) => void;
  onTranscribe: (id: string) => void;
  isTranscribing: boolean;
}) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerHeadRef = useRef<HTMLElement | null>(null);
  const [name, setName] = useState(lead.name ?? "");
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [summary, setSummary] = useState(lead.voicemail_summary ?? "");
  const booked = isBookedLead(lead);
  const priority = getLeadPriority(lead);
  const hasUsefulMessage = Boolean(lead.message && lead.message !== LEGACY_FORWARDING_MESSAGE);
  const summaryGenerating = !lead.voicemail_summary && lead.voicemail_transcription_status === "processing";
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
          ? "Voicemail saved. Summary unavailable. Listen to the recording below."
          : "Voicemail saved. Listen below or generate a quick summary."
        : "No voicemail left. Call back while the request is still fresh.";

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
              <PriorityBadge priority={priority} />
              <SourceBadge source={lead.source} />
              <SmsBadge lead={lead} />
              <VoicemailBadge lead={lead} />
            </div>
          </div>
        </div>

        <section className={`drawer__request ${lead.voicemail_summary ? "drawer__request--summary" : ""}`}>
          <div className="drawer__request-label">
            <Icon name={summaryGenerating ? "sparkle" : "message"} size={14} />
            <span>{requestLabel}</span>
          </div>
          {priority.level !== "normal" ? (
            <div className={`drawer__priority drawer__priority--${priority.level}`}>
              <Icon name={priority.level === "fast" ? "alertTriangle" : "clock"} size={13} />
              <span>{priority.label}{priority.reason ? ` because the caller ${priority.reason}.` : "."}</span>
            </div>
          ) : null}
          <PriorityControl
            value={lead.reply_priority_override}
            onChange={(replyPriorityOverride) => onPriority(lead.id, replyPriorityOverride)}
          />
          {lead.voicemail_summary ? (
            <textarea
              className="field drawer__request-summary"
              rows={3}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              onBlur={() => onSummary(lead.id, summary)}
              aria-label="What the caller needs"
            />
          ) : summaryGenerating ? (
            <div className="drawer__request-pending" role="status">
              <p>Generating voicemail summary...</p>
              <div className="lead-card__summary-progress" aria-hidden="true" />
            </div>
          ) : (
            <p>{requestText}</p>
          )}
        </section>

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

        {lead.recording_sid ? (
          <div className="drawer__message voicemail-card">
            <div>
              <p className="t-eyebrow">Voicemail</p>
              <p style={{ margin: "8px 0 0", color: "var(--ink-2)" }}>
                {formatDuration(lead.recording_duration)}
              </p>
            </div>
            <VoicemailAudio className="voicemail-card__audio" recordingSid={lead.recording_sid} />
            <div className="voicemail-ai">
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
