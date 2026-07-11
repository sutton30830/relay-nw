"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/icon";
import type { InboundMessage, Lead, LeadStatus, OutboundMessage, ReplyPriorityOverride } from "@/lib/supabase";
import { patchLead, requestVoicemailSummary, sendLeadReply } from "../_api";
import { QUICK_REPLIES } from "../_constants";
import { formatPhone, getLeadPriority, initials, isBookedLead, sourceLabel } from "../_utils";
import { BookedToggle, BookedValueInput, PriorityControl, StatusControl } from "../_components/controls";

type ThreadItem =
  | { kind: "call"; lead: Lead; created_at: string }
  | { kind: "autotext"; id: string; created_at: string }
  | { kind: "sms"; id: string; direction: "inbound" | "outbound"; body: string; created_at: string };

const AUTO_TEXT_SENT_STATUSES = new Set(["queued", "sending", "sent", "delivered"]);

function formatClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

// The core "listen → call back" control. It fetches the recording once as a
// blob (the API route needs the auth cookie and doesn't serve range requests),
// holds the whole file in memory so scrubbing is reliable, and cleans up the
// object URL so repeated visits don't leak. fallbackDuration comes from the
// stored recording_duration and seeds the total time before metadata loads.
function VoicemailPlayer({
  recordingSid,
  fallbackDuration,
}: {
  recordingSid: string;
  fallbackDuration: number | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "playing" | "paused" | "error">("idle");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(fallbackDuration && fallbackDuration > 0 ? fallbackDuration : 0);

  // Revoke the blob URL when the player unmounts (navigating away from the
  // conversation) so the fetched audio isn't held forever.
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  async function loadAudio() {
    setStatus("loading");
    try {
      const response = await fetch(`/api/recordings/${recordingSid}`, {
        cache: "no-store",
        credentials: "include",
      });
      if (!response.ok) throw new Error("Recording unavailable");
      const blob = await response.blob();
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = audioRef.current;
      if (!audio) return;
      audio.src = url;
      setLoaded(true);
      await audio.play();
      setStatus("playing");
    } catch {
      setStatus("error");
    }
  }

  function togglePlayback() {
    const audio = audioRef.current;
    if (!loaded || !audio) {
      void loadAudio();
      return;
    }

    if (audio.paused) {
      void audio.play();
      setStatus("playing");
    } else {
      audio.pause();
      setStatus("paused");
    }
  }

  function seek(value: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrentTime(value);
  }

  const isBusy = status === "loading";
  const effectiveDuration = duration > 0 ? duration : fallbackDuration ?? 0;

  return (
    <div className="convo__vm-player">
      <audio
        ref={audioRef}
        preload="none"
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value) && value > 0) setDuration(value);
        }}
        onEnded={() => setStatus("paused")}
      />
      <button
        className="convo__play"
        type="button"
        onClick={togglePlayback}
        disabled={isBusy}
        aria-label={status === "playing" ? "Pause voicemail" : "Play voicemail"}
      >
        {isBusy ? <Icon name="clock" size={13} /> : <Icon name={status === "playing" ? "pause" : "play"} size={13} />}
      </button>

      {status === "error" ? (
        <span className="convo__vm-error">
          Recording unavailable.{" "}
          <button className="convo__vm-retry" type="button" onClick={() => void loadAudio()}>
            Retry
          </button>
        </span>
      ) : (
        <div className="convo__vm-scrub">
          <input
            className="convo__vm-range"
            type="range"
            min={0}
            max={effectiveDuration || 0}
            step={0.1}
            value={Math.min(currentTime, effectiveDuration || 0)}
            disabled={!loaded || !effectiveDuration}
            onChange={(event) => seek(Number(event.target.value))}
            aria-label="Seek voicemail"
          />
          <span className="convo__vm-time" suppressHydrationWarning>
            {formatClock(currentTime)} / {formatClock(effectiveDuration)}
          </span>
        </div>
      )}
    </div>
  );
}

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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sentMessages, setSentMessages] = useState<OutboundMessage[]>([]);
  const [transcribingId, setTranscribingId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [status, setStatus] = useState<LeadStatus>(lead.status);
  const [priorityOverride, setPriorityOverride] = useState<ReplyPriorityOverride>(lead.reply_priority_override);
  const [booked, setBooked] = useState(() => isBookedLead(lead));
  const [jobValueCents, setJobValueCents] = useState<number | null>(lead.job_value_cents);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const priority = getLeadPriority(lead);
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

  useEffect(() => {
    setName(lead.name ?? "");
    setNotes(lead.notes ?? "");
    setStatus(lead.status);
    setPriorityOverride(lead.reply_priority_override);
    setBooked(isBookedLead(lead));
    setJobValueCents(lead.job_value_cents);
    setSaveError(null);
  }, [lead.id, lead.name, lead.notes, lead.status, lead.reply_priority_override, lead.booked_at, lead.job_value_cents]);

  async function patchAndRefresh(body: Parameters<typeof patchLead>[1]) {
    setSaveError(null);
    const ok = await patchLead(lead.id, body);
    if (ok) {
      router.refresh();
    } else {
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
                if ((lead.name ?? null) !== nextName) void patchAndRefresh({ name: nextName });
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
                void patchAndRefresh({ status: nextStatus }).then((ok) => {
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
                void patchAndRefresh({ replyPriorityOverride }).then((ok) => {
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
                  const previousBooked = booked;
                  setBooked(nextBooked);
                  void patchAndRefresh({ booked: nextBooked }).then((ok) => {
                    if (!ok) setBooked(previousBooked);
                  });
                }}
              />
              <BookedValueInput
                valueCents={jobValueCents}
                onSave={(nextJobValueCents) => {
                  const previousJobValueCents = jobValueCents;
                  const previousBooked = booked;
                  const shouldMarkBooked = Boolean(nextJobValueCents && nextJobValueCents > 0 && !booked);
                  setJobValueCents(nextJobValueCents);
                  if (shouldMarkBooked) setBooked(true);
                  void patchAndRefresh({
                    ...(shouldMarkBooked ? { booked: true } : {}),
                    jobValueCents: nextJobValueCents,
                  }).then((ok) => {
                    if (!ok) {
                      setJobValueCents(previousJobValueCents);
                      setBooked(previousBooked);
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
