"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import type { InboundMessage, Lead, LeadStatus, OutboundMessage, ReplyPriorityOverride } from "@/lib/supabase";
import { patchLead, requestVoicemailSummary, sendLeadReply } from "../_api";
import { QUICK_REPLIES } from "../_constants";
import { formatDuration, formatPhone, getLeadPriority, initials, isBookedLead } from "../_utils";
import { BookedToggle, BookedValueInput, PriorityControl, StatusControl } from "../_components/controls";
import { VoicemailAudio } from "../_components/voicemail-audio";

type ThreadItem =
  | { kind: "call"; lead: Lead; created_at: string }
  | { kind: "sms"; id: string; direction: "inbound" | "outbound"; body: string; created_at: string };

function formatTime(iso: string) {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ConversationView({
  lead,
  previousLeads,
  inbound,
  outbound,
  readOnly,
}: {
  lead: Lead;
  previousLeads: Lead[];
  inbound: InboundMessage[];
  outbound: OutboundMessage[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(lead.name ?? "");
  const [notes, setNotes] = useState(lead.notes ?? "");
  const [replyText, setReplyText] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [sentMessages, setSentMessages] = useState<OutboundMessage[]>([]);
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const priority = getLeadPriority(lead);
  const smsTrouble = lead.sms_status === "failed" || lead.sms_status === "undelivered";

  const thread = useMemo<ThreadItem[]>(() => {
    const optimisticIds = new Set(sentMessages.map((message) => message.twilio_message_sid));
    const items: ThreadItem[] = [
      ...[lead, ...previousLeads].map((callLead) => ({
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
  }, [lead, previousLeads, inbound, outbound, sentMessages]);

  // Start (and stay) at the newest message, like any messaging app.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [thread.length]);

  async function patchAndRefresh(body: Parameters<typeof patchLead>[1]) {
    const ok = await patchLead(lead.id, body);
    if (ok) router.refresh();
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
          <p className="convo__name">{lead.name || formatPhone(lead.phone)}</p>
          {lead.name ? <p className="convo__number">{formatPhone(lead.phone)}</p> : null}
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
          {lead.priority_reason ? ` — ${lead.priority_reason}` : ""}
        </p>
      ) : null}
      {smsTrouble ? (
        <p className="convo__banner convo__banner--fast">
          <Icon name="alertTriangle" size={13} /> Text failed to deliver. Call them instead.
        </p>
      ) : null}

      {detailsOpen && !readOnly ? (
        <section className="convo__details">
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
                if ((lead.name ?? null) !== nextName) void patchAndRefresh({ name: nextName });
              }}
            />
          </label>
          <div className="convo__detail">
            <span className="t-eyebrow">Status</span>
            <StatusControl status={lead.status} onChange={(status: LeadStatus) => void patchAndRefresh({ status })} />
          </div>
          <div className="convo__detail">
            <span className="t-eyebrow">Reply timing</span>
            <PriorityControl
              label={null}
              value={lead.reply_priority_override}
              onChange={(replyPriorityOverride: ReplyPriorityOverride) =>
                void patchAndRefresh({ replyPriorityOverride })
              }
            />
          </div>
          <div className="convo__detail">
            <span className="t-eyebrow">Booked job</span>
            <div className="convo__outcome">
              <BookedToggle booked={isBookedLead(lead)} onChange={(booked) => void patchAndRefresh({ booked })} />
              <BookedValueInput
                valueCents={lead.job_value_cents}
                onSave={(jobValueCents) => void patchAndRefresh({ jobValueCents })}
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
                if ((lead.notes ?? "") !== notes) void patchAndRefresh({ notes });
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
                <Icon name="phone" size={12} /> Missed call · {formatTime(item.created_at)}
              </p>
              {item.lead.recording_sid ? (
                <div className="convo__voicemail">
                  <p className="convo__voicemail-label">
                    Voicemail ({formatDuration(item.lead.recording_duration)})
                  </p>
                  {item.lead.voicemail_summary ? (
                    <p className="convo__voicemail-summary">{item.lead.voicemail_summary}</p>
                  ) : null}
                  <VoicemailAudio className="voicemail-card__audio" recordingSid={item.lead.recording_sid} />
                  {item.lead.voicemail_transcript ? (
                    <details className="voicemail-ai__transcript">
                      <summary>Transcript</summary>
                      <p>{item.lead.voicemail_transcript}</p>
                    </details>
                  ) : null}
                  {!readOnly &&
                  !item.lead.voicemail_summary &&
                  item.lead.voicemail_transcription_status !== "processing" ? (
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      disabled={transcribingId === item.lead.id}
                      onClick={() => void summarize(item.lead.id)}
                    >
                      <Icon name="sparkle" size={13} />
                      {transcribingId === item.lead.id ? "Summarizing..." : "Summarize"}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
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
            {QUICK_REPLIES.map((template) => (
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
          </div>
          <div className="convo__input-row">
            <textarea
              ref={composerRef}
              className="field convo__input"
              rows={1}
              maxLength={640}
              placeholder="Text from your business number..."
              value={replyText}
              disabled={replySending}
              onChange={(event) => {
                setReplyText(event.target.value);
                if (replyError) setReplyError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
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
        </footer>
      ) : null}
    </div>
  );
}
