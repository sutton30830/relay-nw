"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import type { Lead, LeadStatus, ReplyPriorityOverride } from "@/lib/supabase";
import { smsDeliveryIssue, smsDeliveryStatusLabel } from "@/lib/twilio/sms-delivery";
import { hasUsableVoicemail } from "@/lib/voicemail-quality";
import type { SendReplyResult } from "../_api";
import { LEGACY_FORWARDING_MESSAGE, QUICK_REPLIES } from "../_constants";
import { followUpStatusText, formatDuration, formatPhone, formatRelativeTime, getLeadPriority, initials, isBookedLead, parseSetupRequestMessage } from "../_utils";
import { BookedBadge, SmsBadge, StatusPill, VoicemailBadge } from "./badges";
import { BookedToggle, BookedValueInput, PriorityControl, StatusControl } from "./controls";
import { SetupRequestDetails } from "./setup-request-details";
import { VoicemailAudio } from "./voicemail-audio";

export function LeadDrawer({
  lead,
  previousLeads = [],
  onClose,
  onStatus,
  onBooked,
  onName,
  onNotes,
  onSummary,
  onJobValue,
  onPriority,
  onTranscribe,
  onReply,
  isTranscribing,
}: {
  lead: Lead;
  previousLeads?: Lead[];
  onClose: () => void;
  onStatus: (id: string, status: LeadStatus) => void;
  onBooked: (id: string, booked: boolean) => void;
  onName: (id: string, name: string | null) => void;
  onNotes: (id: string, notes: string) => void;
  onSummary: (id: string, summary: string) => void;
  onJobValue: (id: string, jobValueCents: number | null) => void;
  onPriority: (id: string, priority: ReplyPriorityOverride) => void;
  onTranscribe: (id: string) => void;
  onReply: (id: string, body: string) => Promise<SendReplyResult>;
  isTranscribing: boolean;
}) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const drawerHeadRef = useRef<HTMLElement | null>(null);
  const [name, setName] = useState(lead.name ?? "");
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [summary, setSummary] = useState(lead.voicemail_summary ?? "");
  const [replyText, setReplyText] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const booked = isBookedLead(lead);
  const thread = [
    ...lead.inbound_messages.map((message) => ({
      id: `in-${message.id}`,
      direction: "inbound" as const,
      body: message.body,
      created_at: message.created_at,
      status: null,
      error: null,
    })),
    ...(lead.outbound_messages ?? []).map((message) => ({
      id: `out-${message.id}`,
      direction: "outbound" as const,
      body: message.body ?? "",
      created_at: message.created_at,
      status: message.status,
      error: message.error,
    })),
  ]
    .filter((message) => message.body)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const priority = getLeadPriority(lead);
  const hasUsefulMessage = Boolean(lead.message && lead.message !== LEGACY_FORWARDING_MESSAGE);
  const setupRequestFields = lead.source === "intake_form" ? parseSetupRequestMessage(lead.message) : [];
  const hasVoicemail = hasUsableVoicemail(lead.recording_sid, lead.recording_duration);
  const summaryGenerating =
    hasVoicemail && !lead.voicemail_summary && lead.voicemail_transcription_status === "processing";
  const transcriptionWasUncertain =
    lead.voicemail_transcription_error?.includes("could not confidently transcribe") ?? false;
  const autoTextIssue = smsDeliveryIssue(lead.sms_status, lead.sms_error);
  const requestLabel = hasVoicemail && lead.voicemail_summary
    ? "What they need"
    : hasUsefulMessage
      ? lead.source === "intake_form"
        ? "Setup request"
        : "Request"
      : hasVoicemail
        ? "Voicemail"
        : "Next step";
  const requestText = hasVoicemail && lead.voicemail_summary
    ? lead.voicemail_summary
    : hasUsefulMessage
      ? lead.message
      : hasVoicemail
        ? lead.voicemail_transcription_status === "failed"
          ? "Voicemail saved. Summary unavailable. Listen to the recording below."
          : lead.voicemail_transcript
            ? "No summary — the voicemail didn't say what they need. Listen below."
            : "Voicemail saved. Listen below or generate a quick summary."
        : "No voicemail left. Call back while the request is still fresh.";

  function resetDrawerScroll() {
    window.scrollTo({ top: 0, behavior: "auto" });

    if (drawerRef.current) {
      drawerRef.current.scrollTop = 0;
    }

    drawerHeadRef.current?.focus({ preventScroll: false });
  }

  // Reset once before paint, plus a single post-paint frame for content that
  // lays out late (audio players). The old rAF/timeout pile-up fought the
  // user's own scrolling for ~100ms after opening.
  useLayoutEffect(() => {
    resetDrawerScroll();
    const frame = window.requestAnimationFrame(resetDrawerScroll);
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setReplyText("");
    setReplyError(null);
    setReplySending(false);
  }, [lead.id]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function submitReply() {
    const body = replyText.trim();
    if (!body || replySending) return;

    setReplySending(true);
    setReplyError(null);

    const result = await onReply(lead.id, body);

    setReplySending(false);

    if (result.ok) {
      setReplyText("");
    } else {
      setReplyError(result.error);
    }
  }

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
              <SmsBadge lead={lead} />
              <VoicemailBadge lead={lead} />
            </div>
          </div>
        </div>

        <div className="drawer__status-row">
          <span className="t-eyebrow">Status</span>
          <StatusControl status={lead.status} onChange={(status) => onStatus(lead.id, status)} />
        </div>

        <section className={`drawer__request ${lead.voicemail_summary ? "drawer__request--summary" : ""}`}>
          <div className="drawer__request-label">
            <Icon name={summaryGenerating ? "sparkle" : "message"} size={14} />
            <span>{requestLabel}</span>
          </div>
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
            setupRequestFields.length > 0 ? (
              <SetupRequestDetails fields={setupRequestFields} />
            ) : (
              <p>{requestText}</p>
            )
          )}
        </section>

        <div className="drawer__priority-row">
          <div>
            <p className="t-eyebrow">Callback timing</p>
            {priority.level !== "normal" ? (
              <p className="drawer__priority-note">
                {priority.level === "fast" ? "Call this lead as soon as possible." : "Call this lead today."}
                {priority.reason ? ` Reason: ${priority.reason}.` : ""}
              </p>
            ) : null}
          </div>
          <PriorityControl
            label={null}
            value={lead.reply_priority_override}
            onChange={(replyPriorityOverride) => onPriority(lead.id, replyPriorityOverride)}
          />
        </div>

        <div className="drawer__value-row">
          <div>
            <p className="t-eyebrow">Outcome</p>
            <p className="drawer__value-copy">
              If this turned into a job, mark it booked and add the value Relay recovered.
            </p>
          </div>
          <BookedToggle booked={booked} onChange={(nextBooked) => onBooked(lead.id, nextBooked)} />
          <BookedValueInput
            valueCents={lead.job_value_cents}
            onSave={(jobValueCents) => onJobValue(lead.id, jobValueCents)}
          />
        </div>

        {hasVoicemail && lead.recording_sid ? (
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
              {!lead.voicemail_summary &&
              !lead.voicemail_transcript &&
              lead.voicemail_transcription_status !== "processing" &&
              !transcriptionWasUncertain ? (
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
          <p className="t-eyebrow">Conversation</p>
          <span style={{ fontSize: 12, color: "var(--ink-4)" }}>
            Texts send from your Relay number
          </span>
        </div>

        <div className="follow-up-panel">
          <div className={`follow-up-status ${autoTextIssue ? "follow-up-status--warn" : ""}`}>
            <Icon name={autoTextIssue ? "alertTriangle" : "message"} size={15} />
            {autoTextIssue ? (
              <div className="sms-delivery-issue">
                <strong>{autoTextIssue.title}</strong>
                <span>{autoTextIssue.guidance}</span>
                <details>
                  <summary>Delivery details</summary>
                  <span>{autoTextIssue.diagnostic}</span>
                </details>
              </div>
            ) : (
              <span>{followUpStatusText(lead)}</span>
            )}
          </div>
          {thread.length > 0 ? (
            <div className="follow-up-replies">
              <div style={{ display: "grid", gap: 8 }}>
                {thread.map((message) => {
                  const issue = message.direction === "outbound"
                    ? smsDeliveryIssue(message.status, message.error)
                    : null;
                  const statusLabel = message.direction === "outbound"
                    ? smsDeliveryStatusLabel(message.status)
                    : null;

                  return (
                    <div
                      key={message.id}
                      className={issue ? "message-bubble message-bubble--failed" : "message-bubble"}
                      style={{
                        background: message.direction === "outbound" ? "var(--panel-2, var(--panel))" : "var(--panel)",
                        marginLeft: message.direction === "outbound" ? 24 : 0,
                        marginRight: message.direction === "outbound" ? 0 : 24,
                      }}
                    >
                      <p style={{ margin: 0 }}>{message.body}</p>
                      <p className="message-bubble__meta">
                        {message.direction === "outbound" ? "You · " : ""}
                        {formatRelativeTime(message.created_at, Date.now())}
                        {statusLabel ? ` · ${statusLabel}` : ""}
                      </p>
                      {issue ? (
                        <div className="message-bubble__issue">
                          <span>{issue.guidance}</span>
                          <details className="message-bubble__diagnostic">
                            <summary>Delivery details</summary>
                            <span>{issue.diagnostic}</span>
                          </details>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div style={{ display: "grid", gap: 8 }}>
            <textarea
              className="field"
              rows={2}
              maxLength={640}
              placeholder={`Text ${lead.name?.split(" ")[0] ?? formatPhone(lead.phone)} back...`}
              value={replyText}
              disabled={replySending}
              onChange={(event) => {
                setReplyText(event.target.value);
                if (replyError) setReplyError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void submitReply();
                }
              }}
            />
            {replyError ? (
              <p style={{ color: "var(--danger, #b42318)", fontSize: 13, margin: 0 }} role="alert">
                {replyError}
              </p>
            ) : null}
            <div className="follow-up-actions">
              <button
                className="btn btn-primary follow-up-actions__primary"
                type="button"
                disabled={replySending || !replyText.trim()}
                onClick={() => void submitReply()}
              >
                <Icon name="message" size={14} /> {replySending ? "Sending..." : "Send text"}
              </button>
              <a className="btn btn-secondary" href={`tel:${lead.phone}`}>
                <Icon name="phone" size={14} /> Call back
              </a>
            </div>
          </div>
          <details className="follow-up-shortcuts">
            <summary>Text shortcuts</summary>
            <div className="follow-up-quick">
              {QUICK_REPLIES.map((template) => (
                <button
                  key={template}
                  className="quick-reply"
                  type="button"
                  onClick={() => {
                    setReplyText(template);
                    setReplyError(null);
                  }}
                >
                  {template}
                </button>
              ))}
            </div>
          </details>
          <p className="follow-up-hint">
            Replies go out from your Relay business number, so the customer sees one conversation.{" "}
            <a href={`sms:${lead.phone}`}>Use your phone instead</a>
          </p>
        </div>

        {previousLeads.length > 0 ? (
          <details style={{ marginTop: 18 }}>
            <summary className="t-eyebrow" style={{ cursor: "pointer", marginBottom: 10 }}>
              Earlier calls from this number ({previousLeads.length})
            </summary>
            <div style={{ display: "grid", gap: 10 }}>
              {previousLeads.map((previous) => (
                <div
                  key={previous.id}
                  style={{
                    background: "var(--panel)",
                    border: "1px solid var(--line)",
                    borderRadius: "var(--r-sm)",
                    padding: "10px 12px",
                  }}
                >
                  <p style={{ color: "var(--ink-4)", fontSize: 12, margin: "0 0 6px" }}>
                    {formatRelativeTime(previous.created_at, Date.now())}
                    {previous.recording_sid ? " · left a voicemail" : " · no voicemail"}
                  </p>
                  {previous.voicemail_summary ? (
                    <p style={{ margin: "0 0 6px" }}>{previous.voicemail_summary}</p>
                  ) : null}
                  {hasUsableVoicemail(previous.recording_sid, previous.recording_duration) && previous.recording_sid ? (
                    <VoicemailAudio recordingSid={previous.recording_sid} />
                  ) : null}
                  {previous.voicemail_transcript ? (
                    <details className="voicemail-ai__transcript">
                      <summary>Transcript</summary>
                      <p>{previous.voicemail_transcript}</p>
                    </details>
                  ) : null}
                </div>
              ))}
            </div>
          </details>
        ) : null}

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
