"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/app/copy-button";
import { Icon } from "@/components/icon";
import type { OwnerServiceStatus } from "@/lib/owner-service-status";
import type { InboundMessage, Lead, LeadStatus, OutboundMessage, ReplyPriorityOverride } from "@/lib/supabase";
import { smsDeliveryIssue, smsDeliveryStatusLabel } from "@/lib/twilio/sms-delivery";
import { hasUsableVoicemail } from "@/lib/voicemail-quality";
import { patchLead, requestVoicemailSummary, sendLeadReply } from "../_api";
import { VoicemailCorrections } from "../_components/voicemail-corrections";
import { VoicemailPlayer } from "../_components/voicemail-player";
import { formatPhone, getLeadPriority, humanVoicemailError, initials, isBookedLead, sourceLabel, voicemailRecoveryAction } from "../_utils";
import { BookedToggle, BookedValueInput, PriorityControl, StatusControl } from "../_components/controls";

type ThreadItem =
  | { kind: "call"; lead: Lead; created_at: string }
  | { kind: "autotext"; id: string; created_at: string }
  | {
      kind: "sms";
      id: string;
      direction: "inbound" | "outbound";
      body: string;
      created_at: string;
      status: string | null;
      error: string | null;
    };

const AUTO_TEXT_SENT_STATUSES = new Set(["queued", "sending", "sent", "delivered"]);

function formatTime(iso: string) {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function leadEventLabel(lead: Lead) {
  const label = sourceLabel(lead.source);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function ConversationView({
  lead,
  previousLeads,
  inbound,
  outbound,
  readOnly,
  quickReplies,
  schedulingUrl,
  providerIssues,
  serviceStatus,
}: {
  lead: Lead;
  previousLeads: Lead[];
  inbound: InboundMessage[];
  outbound: OutboundMessage[];
  readOnly: boolean;
  quickReplies: string[];
  schedulingUrl: string | null;
  providerIssues: Array<{ id: string; explanation: string; nextAction: string }>;
  // Texting from the Relay number is gated server-side (A2P approval plus the
  // owner's automatic text-back choice). The composer only appears when a
  // send would actually succeed; otherwise the owner gets non-SMS actions.
  serviceStatus: Pick<OwnerServiceStatus, "canTextFromRelay" | "texting">;
}) {
  const router = useRouter();
  const [name, setName] = useState(lead.name ?? "");
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [replyText, setReplyText] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sentMessages, setSentMessages] = useState<OutboundMessage[]>([]);
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  // Summary-only recovery that finished without a grounded summary. Remembered
  // so the owner is told to use the transcript instead of being offered the
  // same paid retry again on the next render.
  const [summaryUnavailableIds, setSummaryUnavailableIds] = useState<Set<string>>(() => new Set());
  const [summaryErrors, setSummaryErrors] = useState<Record<string, string>>({});
  // Owner-corrected summaries, shown immediately while the refresh catches up.
  const [summaryOverrides, setSummaryOverrides] = useState<Record<string, string | null>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [statusSaveState, setStatusSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const confirmedStatusRef = useRef<LeadStatus>(lead.status);
  const statusSaveVersionRef = useRef(0);
  const statusSavedTimerRef = useRef<number | null>(null);
  const [priorityOverride, setPriorityOverride] = useState<ReplyPriorityOverride>(lead.reply_priority_override);
  const [bookedAt, setBookedAt] = useState<string | null>(lead.booked_at);
  const [jobValueCents, setJobValueCents] = useState<number | null>(lead.job_value_cents);
  // On touch devices Enter should insert a newline (send is the button) — phones
  // have no Shift+Enter, so sending on Enter would strand multi-line messages.
  // Desktop keeps Enter-to-send. Defaults to false (desktop) until mounted.
  const [isTouch, setIsTouch] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const currentLead = useMemo<Lead>(() => ({
    ...lead,
    name: name.trim() || null,
    notes,
    status,
    reply_priority_override: priorityOverride,
    booked_at: bookedAt,
    job_value_cents: jobValueCents,
  }), [lead, name, notes, status, priorityOverride, bookedAt, jobValueCents]);
  const booked = isBookedLead(currentLead);

  useEffect(() => {
    setIsTouch(window.matchMedia("(hover: none) and (pointer: coarse)").matches);
  }, []);

  const priority = getLeadPriority(currentLead);
  const autoTextIssue = smsDeliveryIssue(lead.sms_status, lead.sms_error);

  const thread = useMemo<ThreadItem[]>(() => {
    const optimisticIds = new Set(sentMessages.map((message) => message.twilio_message_sid));
    const outboundSids = new Set(outbound.map((message) => message.twilio_message_sid));
    // Auto-texts sent before Relay kept full message rows have no body on
    // record. Show a compact "text sent" marker so calls aren't orphaned.
    const syntheticAutoTexts: ThreadItem[] = [lead, ...previousLeads]
      .filter(
        (callLead) =>
          callLead.twilio_message_sid &&
          !outboundSids.has(callLead.twilio_message_sid) &&
          AUTO_TEXT_SENT_STATUSES.has(callLead.sms_status ?? ""),
      )
      .map((callLead) => ({
        kind: "autotext" as const,
        id: `auto-${callLead.id}`,
        created_at: new Date(new Date(callLead.created_at).getTime() + 1000).toISOString(),
      }));
    const items: ThreadItem[] = [
      ...syntheticAutoTexts,
      ...[currentLead, ...previousLeads].map((callLead) => ({
        kind: "call" as const,
        lead: callLead,
        created_at: callLead.created_at,
      })),
      ...inbound
        .filter((message) => message.body)
        .map((message) => ({
          kind: "sms" as const,
          id: `in-${message.id}`,
          direction: "inbound" as const,
          body: message.body ?? "",
          created_at: message.created_at,
          status: null,
          error: null,
        })),
      ...[...outbound.filter((message) => !optimisticIds.has(message.twilio_message_sid)), ...sentMessages]
        .filter((message) => message.body)
        .map((message) => ({
          kind: "sms" as const,
          id: `out-${message.id}`,
          direction: "outbound" as const,
          body: message.body ?? "",
          created_at: message.created_at,
          status: message.status,
          error: message.error,
        })),
    ];

    return items.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [lead, currentLead, previousLeads, inbound, outbound, sentMessages]);

  // Start (and stay) at the newest message, like any messaging app.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [thread.length]);

  useEffect(() => {
    setName(lead.name ?? "");
    setNotes(lead.notes ?? "");
    setStatus(lead.status);
    confirmedStatusRef.current = lead.status;
    setStatusSaveState("idle");
    setPriorityOverride(lead.reply_priority_override);
    setBookedAt(lead.booked_at);
    setJobValueCents(lead.job_value_cents);
    setSaveError(null);
  }, [lead.id, lead.name, lead.notes, lead.status, lead.reply_priority_override, lead.booked_at, lead.job_value_cents]);

  useEffect(() => {
    return () => {
      if (statusSavedTimerRef.current) window.clearTimeout(statusSavedTimerRef.current);
    };
  }, []);

  async function saveLeadPatch(body: Parameters<typeof patchLead>[1]) {
    setSaveError(null);
    const ok = await patchLead(lead.id, body);
    if (!ok) {
      setSaveError("Could not save that change. Try again.");
    }
    return ok;
  }

  async function saveStatus(nextStatus: LeadStatus) {
    if (nextStatus === status || statusSaveState === "saving") return;

    const version = ++statusSaveVersionRef.current;
    const previousStatus = confirmedStatusRef.current;
    if (statusSavedTimerRef.current) window.clearTimeout(statusSavedTimerRef.current);
    setStatus(nextStatus);
    setStatusSaveState("saving");

    const ok = await saveLeadPatch({ status: nextStatus });
    if (version !== statusSaveVersionRef.current) return;

    if (!ok) {
      setStatus(previousStatus);
      setStatusSaveState("error");
      return;
    }

    confirmedStatusRef.current = nextStatus;
    setStatusSaveState("saved");
    statusSavedTimerRef.current = window.setTimeout(() => {
      if (version === statusSaveVersionRef.current) setStatusSaveState("idle");
    }, 1_500);
  }

  async function submitReply() {
    const body = replyText.trim();
    if (!body || replySending) return;

    setReplySending(true);
    setReplyError(null);

    const result = await sendLeadReply(lead.id, body);

    setReplySending(false);

    if (result.ok) {
      setReplyText("");
      setSentMessages((previous) => [...previous, result.message]);
      router.refresh();
    } else {
      setReplyError(result.error);
    }
  }

  async function summarize(callLeadId: string) {
    setTranscribingId(callLeadId);
    setSummaryErrors((previous) => ({ ...previous, [callLeadId]: "" }));
    const result = await requestVoicemailSummary(callLeadId);
    setTranscribingId(null);

    if (result.ok) {
      if (!result.data.summary) {
        setSummaryUnavailableIds((previous) => new Set(previous).add(callLeadId));
      }
    } else {
      setSummaryErrors((previous) => ({ ...previous, [callLeadId]: result.error }));
    }
    router.refresh();
  }

  return (
    <div className="convo">
      <header className="convo__bar">
        <Link className="convo__back" href="/leads" aria-label="Back to inbox">
          &larr;
        </Link>
        <div className="lead-card__avatar">{initials(lead) ?? <Icon name="user" size={16} />}</div>
        <div className="convo__who">
          <p className="convo__name">{currentLead.name || formatPhone(lead.phone)}</p>
          {currentLead.name ? <p className="convo__number">{formatPhone(lead.phone)}</p> : null}
        </div>
        <a className="btn btn-secondary btn-sm" href={`tel:${lead.phone}`}>
          <Icon name="phone" size={14} /> Call
        </a>
        {!readOnly ? (
          <button
            className={`btn btn-ghost btn-sm ${detailsOpen ? "convo__details-toggle--on" : ""}`}
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
          >
            Details
          </button>
        ) : null}
      </header>

      {priority.level !== "normal" ? (
        <p className={`convo__banner ${priority.level === "fast" ? "convo__banner--fast" : ""}`}>
          <Icon name={priority.level === "fast" ? "alertTriangle" : "clock"} size={13} />
          {priority.label}
          {priority.reason ? ` · ${priority.reason}` : ""}
        </p>
      ) : null}
      {autoTextIssue ? (
        <div className="convo__banner convo__banner--fast sms-delivery-banner">
          <Icon name="alertTriangle" size={13} />
          <div>
            <strong>{autoTextIssue.title}</strong>
            <span>{autoTextIssue.guidance}</span>
          </div>
        </div>
      ) : null}
      {providerIssues.map((issue) => (
        <div className="convo__banner convo__banner--fast sms-delivery-banner" key={issue.id} role="status">
          <Icon name="alertTriangle" size={13} />
          <div>
            <strong>{issue.explanation}</strong>
            <span>{issue.nextAction}</span>
          </div>
        </div>
      ))}

      {detailsOpen && !readOnly ? (
        <section className="convo__details">
          {saveError ? (
            <p className="convo__error convo__detail--wide" role="alert">
              {saveError}
            </p>
          ) : null}
          <label className="convo__detail">
            <span className="t-eyebrow">Caller name</span>
            <input
              className="field"
              maxLength={100}
              placeholder="Add caller name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                const nextName = name.trim() || null;
                if ((lead.name ?? null) !== nextName) void saveLeadPatch({ name: nextName });
              }}
            />
          </label>
          <div className="convo__detail">
            <span className="t-eyebrow">Status</span>
            <StatusControl
              status={status}
              disabled={statusSaveState === "saving"}
              onChange={(nextStatus: LeadStatus) => void saveStatus(nextStatus)}
            />
            <span className={`convo__save-state convo__save-state--${statusSaveState}`} role="status">
              {statusSaveState === "saving"
                ? "Saving…"
                : statusSaveState === "saved"
                  ? "Saved"
                  : statusSaveState === "error"
                    ? "Not saved"
                    : ""}
            </span>
          </div>
          <div className="convo__detail">
            <span className="t-eyebrow">Callback timing</span>
            <PriorityControl
              label={null}
              value={priorityOverride}
              onChange={(replyPriorityOverride: ReplyPriorityOverride) => {
                const previousPriority = priorityOverride;
                setPriorityOverride(replyPriorityOverride);
                void saveLeadPatch({ replyPriorityOverride }).then((ok) => {
                  if (!ok) setPriorityOverride(previousPriority);
                });
              }}
            />
          </div>
          <div className="convo__detail">
            <span className="t-eyebrow">Outcome</span>
            <div className="convo__outcome">
              <BookedToggle
                booked={booked}
                onChange={(nextBooked) => {
                  const previousBookedAt = bookedAt;
                  setBookedAt(nextBooked ? previousBookedAt ?? new Date().toISOString() : null);
                  void saveLeadPatch({ booked: nextBooked }).then((ok) => {
                    if (!ok) setBookedAt(previousBookedAt);
                  });
                }}
              />
              <BookedValueInput
                valueCents={jobValueCents}
                onSave={(nextJobValueCents) => {
                  const previousJobValueCents = jobValueCents;
                  const previousBookedAt = bookedAt;
                  const shouldMarkBooked = Boolean(nextJobValueCents && nextJobValueCents > 0 && !booked);
                  setJobValueCents(nextJobValueCents);
                  if (shouldMarkBooked) setBookedAt(new Date().toISOString());
                  void saveLeadPatch({
                    ...(shouldMarkBooked ? { booked: true } : {}),
                    jobValueCents: nextJobValueCents,
                  }).then((ok) => {
                    if (!ok) {
                      setJobValueCents(previousJobValueCents);
                      setBookedAt(previousBookedAt);
                    }
                  });
                }}
              />
            </div>
          </div>
          <label className="convo__detail convo__detail--wide">
            <span className="t-eyebrow">Private notes</span>
            <textarea
              className="field"
              rows={2}
              placeholder="Only you see these."
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              onBlur={() => {
                if ((lead.notes ?? "") !== notes) void saveLeadPatch({ notes });
              }}
            />
            {previousLeads.some((earlier) => earlier.notes) ? (
              <div className="convo__earlier-notes">
                {previousLeads
                  .filter((earlier) => earlier.notes)
                  .map((earlier) => (
                    <p key={earlier.id} suppressHydrationWarning>
                      <span>{formatTime(earlier.created_at)}:</span> {earlier.notes}
                    </p>
                  ))}
              </div>
            ) : null}
          </label>
        </section>
      ) : null}

      <div className="convo__thread">
        {thread.map((item) =>
          item.kind === "call" ? (
            <div key={`call-${item.lead.id}`} className="convo__event">
              <p className="convo__event-line" suppressHydrationWarning>
                <Icon name={item.lead.source === "missed_call" ? "phone" : "message"} size={12} />{" "}
                {leadEventLabel(item.lead)} · {formatTime(item.created_at)}
              </p>
              {hasUsableVoicemail(item.lead.recording_sid, item.lead.recording_duration) && item.lead.recording_sid ? (
                <div className="convo__msg convo__msg--in convo__vm">
                  <span className="convo__vm-label">Voicemail</span>
                  <VoicemailPlayer
                    providerRecordingId={item.lead.recording_sid}
                    fallbackDuration={item.lead.recording_duration}
                  />
                  {(() => {
                    const shownSummary = item.lead.id in summaryOverrides
                      ? summaryOverrides[item.lead.id]
                      : item.lead.voicemail_summary;
                    return shownSummary ? <p className="convo__msg-body">{shownSummary}</p> : null;
                  })()}
                  {item.lead.voicemail_transcript ? (
                    <details className="convo__vm-transcript">
                      <summary>Transcript</summary>
                      <p>{item.lead.voicemail_transcript}</p>
                    </details>
                  ) : null}
                  {!readOnly ? (
                    <VoicemailCorrections
                      leadId={item.lead.id}
                      summary={item.lead.id in summaryOverrides ? summaryOverrides[item.lead.id] : item.lead.voicemail_summary}
                      hasTranscript={Boolean(item.lead.voicemail_transcript)}
                      onSummarySaved={(savedLeadId, savedSummary) => {
                        setSummaryOverrides((previous) => ({ ...previous, [savedLeadId]: savedSummary }));
                        router.refresh();
                      }}
                      onDisputed={() => {
                        setSummaryOverrides((previous) => ({ ...previous, [item.lead.id]: null }));
                        router.refresh();
                      }}
                    />
                  ) : null}
                  {item.lead.voicemail_transcript && !item.lead.voicemail_summary && !summaryOverrides[item.lead.id] ? (
                    <p className="convo__msg-meta">
                      {summaryUnavailableIds.has(item.lead.id)
                        ? "Relay could not write a reliable summary from this transcript. The transcript is the source of truth."
                        : "No summary yet — read the transcript, or generate one from it."}
                    </p>
                  ) : null}
                  {!item.lead.voicemail_transcript &&
                  item.lead.voicemail_transcription_status === "failed" ? (
                    <p className="convo__msg-meta">{humanVoicemailError(item.lead.voicemail_transcription_error)}</p>
                  ) : null}
                  {summaryErrors[item.lead.id] ? (
                    <p className="convo__msg-meta convo__msg-meta--error" role="alert">{summaryErrors[item.lead.id]}</p>
                  ) : null}
                  {/* A transcript-only voicemail recovers its summary from the
                      stored transcript (no audio download, no retranscription);
                      the server claims the lead so concurrent taps and the
                      scheduled recovery job cannot double-run it. */}
                  {!readOnly &&
                  !summaryUnavailableIds.has(item.lead.id) &&
                  !summaryOverrides[item.lead.id] &&
                  voicemailRecoveryAction(item.lead) ? (
                    <button
                      className="convo__vm-summarize"
                      type="button"
                      disabled={transcribingId === item.lead.id}
                      onClick={() => void summarize(item.lead.id)}
                    >
                      {transcribingId === item.lead.id
                        ? "Summarizing..."
                        : voicemailRecoveryAction(item.lead) === "summary"
                          ? "Generate summary from transcript"
                          : "Summarize"}
                    </button>
                  ) : null}
                </div>
              ) : item.lead.recording_sid ? (
                <p className="convo__event-line convo__event-line--quiet">
                  Caller hung up without leaving a message.
                </p>
              ) : null}
            </div>
          ) : item.kind === "autotext" ? (
            <p key={item.id} className="convo__event-line convo__event-line--sent" suppressHydrationWarning>
              <Icon name="message" size={12} /> Missed-call text sent automatically
            </p>
          ) : (() => {
            const issue = item.direction === "outbound"
              ? smsDeliveryIssue(item.status, item.error)
              : null;
            const statusLabel = item.direction === "outbound"
              ? smsDeliveryStatusLabel(item.status)
              : null;

            return (
              <div
                key={item.id}
                className={`convo__msg ${item.direction === "outbound" ? "convo__msg--out" : "convo__msg--in"} ${issue ? "convo__msg--failed" : ""}`}
              >
                <p className="convo__msg-body">{item.body}</p>
                <p className="convo__msg-meta" suppressHydrationWarning>
                  {formatTime(item.created_at)}
                  {statusLabel ? ` · ${statusLabel}` : ""}
                </p>
                {issue ? (
                  <div className="convo__msg-issue">
                    <span>{issue.guidance}</span>
                  </div>
                ) : null}
              </div>
            );
          })(),
        )}
        <div ref={threadEndRef} />
      </div>

      {!readOnly && !serviceStatus.canTextFromRelay ? (
        <footer className="convo__composer convo__no-text" aria-label="Follow-up actions">
          <p className="convo__no-text-copy">
            <Icon name="info" size={13} />
            <span>
              <strong>Texting from your Relay number is not on yet.</strong>{" "}
              {serviceStatus.texting.nextStep ?? serviceStatus.texting.detail}
            </span>
          </p>
          <div className="convo__no-text-actions">
            <a className="btn btn-primary btn-sm" href={`tel:${lead.phone}`}>
              <Icon name="phone" size={13} /> Call back
            </a>
            <a className="btn btn-secondary btn-sm" href={`sms:${lead.phone}`}>
              <Icon name="message" size={13} /> Text from my phone
            </a>
            <CopyButton value={formatPhone(lead.phone)} label="Copy number" />
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen(true)}
            >
              Add note or mark contacted
            </button>
          </div>
        </footer>
      ) : null}

      {!readOnly && serviceStatus.canTextFromRelay ? (
        <footer className="convo__composer">
          {replyError ? (
            <p className="convo__error" role="alert">
              {replyError}
            </p>
          ) : null}
          <div className="convo__chips clean-scroll">
            {quickReplies.map((template) => (
              <button
                key={template}
                className="quick-reply"
                type="button"
                onClick={() => {
                  setReplyText(template);
                  setReplyError(null);
                  composerRef.current?.focus();
                }}
              >
                {template}
              </button>
            ))}
            {schedulingUrl ? (
              <button
                className="quick-reply quick-reply--book"
                type="button"
                onClick={() => {
                  // Append the booking link so the owner can pair it with a
                  // reply ("Can I come by tomorrow? Book here: …") instead of
                  // replacing what they've already picked.
                  setReplyText((current) => {
                    const bookingLine = `Book here: ${schedulingUrl}`;
                    const trimmed = current.trim();
                    return trimmed ? `${trimmed}\n\n${bookingLine}` : bookingLine;
                  });
                  setReplyError(null);
                  composerRef.current?.focus();
                }}
              >
                <Icon name="calendar" size={13} /> Send booking link
              </button>
            ) : null}
          </div>
          <div className="convo__input-row">
            <textarea
              ref={composerRef}
              className="field convo__input"
              rows={1}
              maxLength={640}
              enterKeyHint={isTouch ? "enter" : "send"}
              placeholder="Text from your business number..."
              value={replyText}
              disabled={replySending}
              onChange={(event) => {
                setReplyText(event.target.value);
                if (replyError) setReplyError(null);
              }}
              onKeyDown={(event) => {
                // Desktop only: Enter sends, Shift+Enter is a newline. On touch,
                // Enter falls through to its default (newline) and the button sends.
                if (!isTouch && event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submitReply();
                }
              }}
            />
            <button
              className="convo__send"
              type="button"
              aria-label="Send text"
              disabled={replySending || !replyText.trim()}
              onClick={() => void submitReply()}
            >
              <Icon name="arrowRight" size={18} />
            </button>
          </div>
          <p className="convo__composer-hint">
            <strong>Enter</strong> sends · <strong>Shift+Enter</strong> for a new line
          </p>
        </footer>
      ) : null}
    </div>
  );
}
