"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { disputeVoicemailTranscript, patchLead } from "../_api";

const MAX_SUMMARY_LENGTH = 500;

// The owner just listened to the recording and is the only one who knows the
// caller said "Ballard", not "ballot". Two corrections, both inline, both
// one thumb: rewrite the summary, or mark the whole transcript wrong.
export function VoicemailCorrections({
  leadId,
  summary,
  hasTranscript,
  onSummarySaved,
  onDisputed,
}: {
  leadId: string;
  summary: string | null;
  hasTranscript: boolean;
  onSummarySaved: (leadId: string, summary: string | null) => void;
  onDisputed: (leadId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmingDispute, setConfirmingDispute] = useState(false);
  const [disputing, setDisputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) setDraft(summary ?? "");
  }, [summary, editing]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  async function saveSummary() {
    const next = draft.trim().slice(0, MAX_SUMMARY_LENGTH) || null;
    if (next === (summary ?? null)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    const ok = await patchLead(leadId, { voicemailSummary: next });
    setSaving(false);
    if (!ok) {
      setError("Could not save the summary. Try again.");
      return;
    }
    setEditing(false);
    onSummarySaved(leadId, next);
  }

  async function dispute() {
    setDisputing(true);
    setError(null);
    const result = await disputeVoicemailTranscript(leadId);
    setDisputing(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setConfirmingDispute(false);
    onDisputed(leadId);
  }

  if (!summary && !hasTranscript) return null;

  return (
    <div className="vm-fix">
      {editing ? (
        <div className="vm-fix__editor">
          <label className="t-eyebrow" htmlFor={`vm-summary-${leadId}`}>Fix the summary</label>
          <textarea
            id={`vm-summary-${leadId}`}
            ref={textareaRef}
            className="field"
            rows={3}
            maxLength={MAX_SUMMARY_LENGTH}
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setEditing(false);
              }
            }}
          />
          <div className="vm-fix__actions">
            <button className="btn btn-primary btn-sm" type="button" disabled={saving} onClick={() => void saveSummary()}>
              {saving ? "Saving..." : "Save summary"}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : confirmingDispute ? (
        <div className="vm-fix__confirm" role="group" aria-label="Confirm hiding this transcript">
          <p>
            Hide this transcript{summary ? " and summary" : ""}? Relay keeps the recording and will not
            re-transcribe it.
          </p>
          <div className="vm-fix__actions">
            <button className="btn btn-secondary btn-sm" type="button" disabled={disputing} onClick={() => void dispute()}>
              {disputing ? "Hiding..." : "Yes, it's wrong"}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" disabled={disputing} onClick={() => setConfirmingDispute(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="vm-fix__links">
          <button className="vm-fix__link" type="button" onClick={() => setEditing(true)}>
            <Icon name="sparkle" size={12} /> {summary ? "Fix summary" : "Write summary"}
          </button>
          {hasTranscript ? (
            <button className="vm-fix__link vm-fix__link--muted" type="button" onClick={() => setConfirmingDispute(true)}>
              This transcript is wrong
            </button>
          ) : null}
        </div>
      )}
      {error ? (
        <p className="convo__msg-meta convo__msg-meta--error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
