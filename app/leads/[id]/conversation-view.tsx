"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import type { InboundMessage, Lead, LeadStatus, OutboundMessage, ReplyPriorityOverride } from "@/lib/supabase";
import { patchLead, requestVoicemailSummary, sendLeadReply } from "../_api";
import { VoicemailPlayer } from "../_components/voicemail-player";
import { formatPhone, getLeadPriority, initials, isBookedLead, sourceLabel } from "../_utils";
import { BookedToggle, BookedValueInput, PriorityControl, StatusControl } from "../_components/controls";

type ThreadItem =
  | { kind: "call"; lead: Lead; created_at: string }
  | { kind: "autotext"; id: string; created_at: string }
  | { kind: "sms"; id: string; direction: "inbound" | "outbound"; body: string; created_at: string };

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
}: {
  lead: Lead;
  previousLeads: Lead[];
  inbound: InboundMessage[];
  outbound: OutboundMessage[];
  readOnly: boolean;
  quickReplies: string[];
  schedulingUrl: string | null;
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [priorityOverride, setPriorityOverride] = useState<ReplyPriorityOverride>(lead.reply_priority_override);
  const [bookedAt, setBookedAt] = useState<string | null>(lead.booked_at);
  const [jobValueCents, setJobValueCents] = useState<number | null>(lead.job_value_cents);
  // On touch devices Enter should insert a newline (send is the button) — phones
  // have no Shift+Enter, so sending on Enter would strand multi-line messages.
  // Desktop keeps Enter-to-send. Defaults to false (desktop) until mounted.
  const [isTouch, setIsTouch] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const currentLead: Lead = {
    ...lead,
    name: name.trim() || null,
    notes,
    status,
    reply_priority_override: priorityOverride,
    booked_at: bookedAt,
    job_value_cents: jobValueCents,
  };
  const booked = isBookedLead(currentLead);

  useEffect(() => {
    setIsTouch(window.matchMedia("(hover: none) and (pointer: coarse)").matches);
  }, []);

  const priority = getLeadPriority(currentLead);
  const smsTrouble = lead.sms_status === "failed" || lead.sms_status === "undelivered";

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
        })),
      ...[...outbound.filter((message) => !optimisticIds.has(message.twilio_message_sid)), ...sentMessages]
        .filter((message) => message.body)
        .map((message) => ({
          kind: "sms" as const,
          id: `out-${message.id}`,
          direction: "outbound" as const,
          body: message.body ?? "",
          created_at: message.created_at,
        })),
    ];

    return items.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  }, [currentLead, previousLeads, inbound, outbound, sentMessages]);

  // Start (and stay) at the newest message, like any messaging app.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [thread.length]);

  useEffect(() => {
    setName(lead.name ?? "");
    setNotes(lead.notes ?? "");
    setStatus(lead.status);
    setPriorityOverride(lead.reply_priority_override);
    setBookedAt(lead.booked_at);
    setJobValueCents(lead.job_value_cents);
    setSaveError(null);
  }, [lead.id, lead.name, lead.notes, lead.status, lead.reply_priority_override, lead.booked_at, lead.job_value_cents]);

  async function saveLeadPatch(body: Parameters<typeof patchLead>[1]) {
    setSaveError(null);
    const ok = await patchLead(lead.id, body);
    if (!ok) {
      setSaveError("Could not save that change. Try again.");
    }
    return ok;
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
    await requestVoicemailSummary(callLeadId);
    setTranscribingId(null);
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
      {smsTrouble ? (
        <p className="convo__banner convo__banner--fast">
          <Icon name="alertTriangle" size={13} /> Text failed to deliver. Call them instead.
        </p>
      ) : null}

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
              onChange={(nextStatus: LeadStatus) => {
                const previousStatus = status;
                setStatus(nextStatus);
                void saveLeadPatch({ status: nextStatus }).then((ok) => {
                  if (!ok) setStatus(previousStatus);
                });
              }}
            />
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
              {item.lead.recording_sid ? (
                <div className="convo__msg convo__msg--in convo__vm">
                  <span className="convo__vm-label">Voicemail</span>
                  <VoicemailPlayer
                    recordingSid={item.lead.recording_sid}
                    fallbackDuration={item.lead.recording_duration}
                  />
                  {item.lead.voicemail_summary ? (
                    <p className="convo__msg-body">{item.lead.voicemail_summary}</p>
                  ) : null}
                  {item.lead.voicemail_transcript ? (
                    <details className="convo__vm-transcript">
                      <summary>Transcript</summary>
                      <p>{item.lead.voicemail_transcript}</p>
                    </details>
                  ) : null}
                  {item.lead.voicemail_transcript && !item.lead.voicemail_summary ? (
                    <p className="convo__msg-meta">No clear summary — listen or read the transcript.</p>
                  ) : null}
                  {!readOnly &&
                  !item.lead.voicemail_summary &&
                  !item.lead.voicemail_transcript &&
                  item.lead.voicemail_transcription_status !== "processing" ? (
                    <button
                      className="convo__vm-summarize"
                      type="button"
                      disabled={transcribingId === item.lead.id}
                      onClick={() => void summarize(item.lead.id)}
                    >
                      {transcribingId === item.lead.id ? "Summarizing..." : "Summarize"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : item.kind === "autotext" ? (
            <p key={item.id} className="convo__event-line convo__event-line--sent" suppressHydrationWarning>
              <Icon name="message" size={12} /> Missed-call text sent automatically
            </p>
          ) : (
            <div
              key={item.id}
              className={`convo__msg ${item.direction === "outbound" ? "convo__msg--out" : "convo__msg--in"}`}
            >
              <p className="convo__msg-body">{item.body}</p>
              <p className="convo__msg-meta" suppressHydrationWarning>
                {formatTime(item.created_at)}
              </p>
            </div>
          ),
        )}
        <div ref={threadEndRef} />
      </div>

      {!readOnly ? (
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
