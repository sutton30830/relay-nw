"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import type { InboundMessage, Lead, LeadStatus, OutboundMessage, ReplyPriorityOverride } from "@/lib/supabase";
import { patchLead, requestVoicemailSummary, sendLeadReply } from "../_api";
import { QUICK_REPLIES } from "../_constants";
import {
  followUpStatusText,
  formatDuration,
  formatPhone,
  formatRelativeTime,
  getLeadPriority,
  initials,
  isBookedLead,
} from "../_utils";
import { BookedBadge, PriorityBadge, SmsBadge, StatusPill } from "../_components/badges";
import { BookedToggle, BookedValueInput, PriorityControl, StatusControl } from "../_components/controls";
import { VoicemailAudio } from "../_components/voicemail-audio";

type ThreadItem =
  | { kind: "call"; lead: Lead; created_at: string }
  | { kind: "sms"; id: string; direction: "inbound" | "outbound"; body: string; created_at: string };

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
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const priority = getLeadPriority(lead);
  const now = Date.now();

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
    <div className="conversation">
      <header className="conversation__topbar">
        <Link className="btn btn-ghost btn-sm" href="/leads">
          &larr; Inbox
        </Link>
        <div className="conversation__topbar-actions">
          <a className="btn btn-secondary btn-sm" href={`tel:${lead.phone}`}>
            <Icon name="phone" size={14} /> Call
          </a>
        </div>
      </header>

      <section className="conversation__hero">
        <div className="lead-card__avatar lead-card__avatar--lg">
          {initials(lead) ?? <Icon name="user" size={22} />}
        </div>
        <div className="conversation__hero-body">
          <h1 className="t-display conversation__title">{lead.name || "Unknown caller"}</h1>
          <p className="t-mono conversation__phone">{formatPhone(lead.phone)}</p>
          <div className="conversation__badges">
            <StatusPill status={lead.status} />
            <BookedBadge lead={lead} />
            <SmsBadge lead={lead} />
            {priority.level !== "normal" ? <PriorityBadge priority={priority} /> : null}
          </div>
        </div>
      </section>

      {!readOnly ? (
        <section className="conversation__controls">
          <label className="conversation__control">
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
          <div className="conversation__control">
            <span className="t-eyebrow">Status</span>
            <StatusControl status={lead.status} onChange={(status: LeadStatus) => void patchAndRefresh({ status })} />
          </div>
          <div className="conversation__control">
            <span className="t-eyebrow">Reply timing</span>
            <PriorityControl
              label={null}
              value={lead.reply_priority_override}
              onChange={(replyPriorityOverride: ReplyPriorityOverride) =>
                void patchAndRefresh({ replyPriorityOverride })
              }
            />
          </div>
          <div className="conversation__control">
            <span className="t-eyebrow">Outcome</span>
            <div className="conversation__outcome">
              <BookedToggle booked={isBookedLead(lead)} onChange={(booked) => void patchAndRefresh({ booked })} />
              <BookedValueInput
                valueCents={lead.job_value_cents}
                onSave={(jobValueCents) => void patchAndRefresh({ jobValueCents })}
              />
            </div>
          </div>
        </section>
      ) : null}

      {lead.voicemail_summary ? (
        <section className="conversation__summary">
          <p className="t-eyebrow">
            <Icon name="sparkle" size={13} /> What they need
          </p>
          <p>{lead.voicemail_summary}</p>
        </section>
      ) : null}

      <section className="conversation__thread" aria-label="Conversation history">
        <p className="conversation__sms-note">{followUpStatusText(lead)}</p>
        {thread.map((item) =>
          item.kind === "call" ? (
            <div key={`call-${item.lead.id}`} className="conversation__call">
              <p className="conversation__call-head">
                <Icon name="phone" size={13} /> Missed call · {formatRelativeTime(item.created_at, now)}
                {item.lead.recording_sid
                  ? ` · voicemail (${formatDuration(item.lead.recording_duration)})`
                  : " · no voicemail"}
              </p>
              {item.lead.voicemail_summary ? <p className="conversation__call-summary">{item.lead.voicemail_summary}</p> : null}
              {item.lead.recording_sid ? (
                <VoicemailAudio className="voicemail-card__audio" recordingSid={item.lead.recording_sid} />
              ) : null}
              {item.lead.voicemail_transcript ? (
                <details className="voicemail-ai__transcript">
                  <summary>Transcript</summary>
                  <p>{item.lead.voicemail_transcript}</p>
                </details>
              ) : null}
              {!readOnly &&
              item.lead.recording_sid &&
              !item.lead.voicemail_summary &&
              item.lead.voicemail_transcription_status !== "processing" ? (
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  disabled={transcribingId === item.lead.id}
                  onClick={() => void summarize(item.lead.id)}
                >
                  <Icon name="sparkle" size={13} />
                  {transcribingId === item.lead.id ? "Summarizing..." : "Summarize voicemail"}
                </button>
              ) : null}
            </div>
          ) : (
            <div
              key={item.id}
              className={`conversation__bubble ${
                item.direction === "outbound" ? "conversation__bubble--out" : "conversation__bubble--in"
              }`}
            >
              <p className="conversation__bubble-body">{item.body}</p>
              <p className="conversation__bubble-meta">
                {item.direction === "outbound" ? "You · " : ""}
                {formatRelativeTime(item.created_at, now)}
              </p>
            </div>
          ),
        )}
      </section>

      {!readOnly ? (
        <section className="conversation__composer">
          <textarea
            ref={composerRef}
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
            <p className="conversation__reply-error" role="alert">
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
          </div>
          <div className="follow-up-quick">
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
          <p className="follow-up-hint">
            Texts send from your Relay business number, so the customer sees one conversation.
          </p>
        </section>
      ) : null}

      {!readOnly ? (
        <section className="conversation__notes">
          <p className="t-eyebrow">Private notes</p>
          <textarea
            className="field"
            rows={3}
            placeholder="Private notes - only you see these."
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            onBlur={() => {
              if ((lead.notes ?? "") !== notes) void patchAndRefresh({ notes });
            }}
          />
        </section>
      ) : null}
    </div>
  );
}
