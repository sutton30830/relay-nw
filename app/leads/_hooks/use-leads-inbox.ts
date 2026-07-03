"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lead, LeadStatus, OutboundMessage, ReplyPriorityOverride } from "@/lib/supabase";
import { AUTO_VOICEMAIL_SUMMARY_LIMIT, INBOX_REFRESH_MS, RELATIVE_TIME_TICK_MS, UNDO_DELETE_MS } from "../_constants";
import type { Filter } from "../_types";
import { deleteLead as deleteLeadRequest, patchLead, requestVoicemailSummary, sendLeadReply, type SendReplyResult } from "../_api";
import { condenseLeadsByPhone, countCallsByPhone, countLeads, createSampleLeads, filterLeads, shouldAutoSummarizeVoicemail, sortLeadsForWork } from "../_utils";

type UndoableDelete = {
  leadId: string;
  label: string;
};

// Fields where the server generates its own value (timestamps), so "did the
// server confirm this edit?" is a truthy comparison, not strict equality.
const TRUTHY_MATCH_FIELDS = new Set<keyof Lead>(["deleted_at", "booked_at"]);

function serverConfirms(field: keyof Lead, serverValue: unknown, optimisticValue: unknown) {
  if (TRUTHY_MATCH_FIELDS.has(field)) {
    return Boolean(serverValue) === Boolean(optimisticValue);
  }

  return (serverValue ?? null) === (optimisticValue ?? null);
}

export function useLeadsInbox(leads: Lead[]) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const initiallyLoadedLeadIds = useRef<Set<string>>(new Set(leads.map((lead) => lead.id)));
  const autoSummaryStartedIds = useRef<Set<string>>(new Set());
  // Every optimistic edit is recorded here until the server echoes it back.
  // Without this, the 8s router.refresh() can land with pre-write data and
  // silently snap the UI back to a state the user already changed.
  const pendingLeadWrites = useRef<Map<string, Partial<Lead>>>(new Map());
  const pendingPhoneWrites = useRef<Map<string, Partial<Lead>>>(new Map());
  const undoTimerRef = useRef<number | null>(null);
  const [items, setItems] = useState(leads);
  const [sampleItems, setSampleItems] = useState(() => createSampleLeads());
  const [sampleMode, setSampleMode] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [transcribingIds, setTranscribingIds] = useState<Set<string>>(() => new Set());
  const [expandedLeadIds, setExpandedLeadIds] = useState<Set<string>>(() => new Set());
  const [undoableDelete, setUndoableDelete] = useState<UndoableDelete | null>(null);
  const activeItems = sampleMode ? sampleItems : items;

  useEffect(() => {
    setItems(applyPendingWrites(leads));
    if (leads.length > 0) setSampleMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leads]);

  useEffect(() => {
    function refreshInbox() {
      router.refresh();
      setNow(Date.now());
    }

    const id = window.setInterval(refreshInbox, INBOX_REFRESH_MS);

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        refreshInbox();
      }
    }

    window.addEventListener("focus", refreshInbox);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refreshInbox);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (sampleMode || autoSummaryStartedIds.current.size >= AUTO_VOICEMAIL_SUMMARY_LIMIT) {
      return;
    }

    const remaining = AUTO_VOICEMAIL_SUMMARY_LIMIT - autoSummaryStartedIds.current.size;
    const candidates = activeItems
      .filter((lead) => shouldAutoSummarizeVoicemail(lead, now, initiallyLoadedLeadIds.current))
      .filter((lead) => !autoSummaryStartedIds.current.has(lead.id) && !transcribingIds.has(lead.id))
      .slice(0, remaining);

    for (const lead of candidates) {
      autoSummaryStartedIds.current.add(lead.id);
      void transcribeVoicemail(lead.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeItems, now, sampleMode, transcribingIds]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // "N calls" counts every lead row for the phone — including trashed ones —
  // so the number is the truth about the caller and never moves when a card
  // is trashed or restored.
  const callCounts = useMemo(() => countCallsByPhone(activeItems), [activeItems]);

  // One conversation per customer: live leads condense to the newest row per
  // phone, and Trash condenses the same way so a repeat caller is one card
  // there too, not a fragment per call.
  const condensed = useMemo(
    () => condenseLeadsByPhone(activeItems.filter((lead) => !lead.deleted_at)),
    [activeItems],
  );
  const condensedTrash = useMemo(
    () => condenseLeadsByPhone(activeItems.filter((lead) => lead.deleted_at)),
    [activeItems],
  );
  const counts = useMemo(
    () => countLeads([...condensed.leads, ...condensedTrash.leads]),
    [condensed, condensedTrash],
  );
  const filteredItems = useMemo(
    () =>
      filter === "trash"
        ? filterLeads(condensedTrash.leads, filter, query)
        : filterLeads(condensed.leads, filter, query),
    [condensed, condensedTrash, filter, query],
  );
  const sortedItems = useMemo(
    () => sortLeadsForWork(filteredItems),
    [filteredItems],
  );

  const openLead = activeItems.find((lead) => lead.id === openId) ?? null;

  function updateLocalLead(id: string, updates: Partial<Lead>) {
    const setter = sampleMode ? setSampleItems : setItems;
    setter((current) => current.map((lead) => (lead.id === id ? { ...lead, ...updates } : lead)));
  }

  // Reconcile server data against in-flight optimistic edits. Fields the
  // server already reflects are confirmed and dropped; the rest stay applied
  // on top so a stale refresh can never undo what the user just did.
  function applyPendingWrites(nextItems: Lead[]) {
    if (pendingLeadWrites.current.size === 0 && pendingPhoneWrites.current.size === 0) {
      return nextItems;
    }

    for (const [id, fields] of pendingLeadWrites.current) {
      const serverLead = nextItems.find((lead) => lead.id === id);
      if (!serverLead) continue;

      for (const key of Object.keys(fields) as Array<keyof Lead>) {
        if (serverConfirms(key, serverLead[key], fields[key])) {
          delete fields[key];
        }
      }

      if (Object.keys(fields).length === 0) pendingLeadWrites.current.delete(id);
    }

    for (const [phone, fields] of pendingPhoneWrites.current) {
      const phoneLeads = nextItems.filter((lead) => lead.phone === phone);
      if (phoneLeads.length === 0) continue;

      for (const key of Object.keys(fields) as Array<keyof Lead>) {
        if (phoneLeads.every((lead) => serverConfirms(key, lead[key], fields[key]))) {
          delete fields[key];
        }
      }

      if (Object.keys(fields).length === 0) pendingPhoneWrites.current.delete(phone);
    }

    if (pendingLeadWrites.current.size === 0 && pendingPhoneWrites.current.size === 0) {
      return nextItems;
    }

    return nextItems.map((lead) => {
      const phoneFields = pendingPhoneWrites.current.get(lead.phone);
      const leadFields = pendingLeadWrites.current.get(lead.id);
      if (!phoneFields && !leadFields) return lead;
      return { ...lead, ...phoneFields, ...leadFields };
    });
  }

  function recordPendingWrite(map: Map<string, Partial<Lead>>, key: string, fields: Partial<Lead>) {
    map.set(key, { ...map.get(key), ...fields });
  }

  function discardPendingWrite(map: Map<string, Partial<Lead>>, key: string, fieldNames: string[]) {
    const pending = map.get(key);
    if (!pending) return;

    for (const field of fieldNames) {
      delete pending[field as keyof Lead];
    }

    if (Object.keys(pending).length === 0) map.delete(key);
  }

  // Single path for optimistic edits: apply locally, remember the write until
  // the server confirms it, and on failure roll back only the fields this
  // mutation touched (a snapshot of the whole list could wipe out fresher
  // data that arrived from a refresh in the meantime).
  async function mutateLeads(
    targets: Array<{ id: string; fields: Partial<Lead> }>,
    request: () => Promise<boolean>,
  ): Promise<boolean> {
    if (targets.length === 0) return true;

    if (sampleMode) {
      setSampleItems((current) =>
        current.map((lead) => {
          const target = targets.find((item) => item.id === lead.id);
          return target ? { ...lead, ...target.fields } : lead;
        }),
      );
      return true;
    }

    const previousFields = new Map<string, Partial<Lead>>();

    for (const target of targets) {
      const lead = items.find((item) => item.id === target.id);
      if (!lead) continue;

      const previous: Partial<Lead> = {};
      for (const key of Object.keys(target.fields) as Array<keyof Lead>) {
        (previous as Record<string, unknown>)[key] = lead[key];
      }
      previousFields.set(target.id, previous);
      recordPendingWrite(pendingLeadWrites.current, target.id, target.fields);
    }

    setItems((current) =>
      current.map((lead) => {
        const target = targets.find((item) => item.id === lead.id);
        return target ? { ...lead, ...target.fields } : lead;
      }),
    );

    const saved = await request();

    if (!saved) {
      for (const target of targets) {
        discardPendingWrite(pendingLeadWrites.current, target.id, Object.keys(target.fields));
      }

      setItems((current) =>
        current.map((lead) => {
          const previous = previousFields.get(lead.id);
          return previous ? { ...lead, ...previous } : lead;
        }),
      );
    }

    return saved;
  }

  function toggleLeadDetails(id: string) {
    setExpandedLeadIds((current) => {
      const next = new Set(current);

      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }

      return next;
    });
  }

  function leadById(id: string) {
    return activeItems.find((lead) => lead.id === id) ?? null;
  }

  async function updateStatus(id: string, status: LeadStatus) {
    await mutateLeads([{ id, fields: { status } }], () => patchLead(id, { status }));
  }

  // Trashing a caller trashes the whole thread: the visible card is just the
  // newest row for the phone, so a single-row delete would let the next-newest
  // row pop right back up as a "new" card.
  async function deleteLead(id: string) {
    const lead = leadById(id);
    if (!lead) return;

    const deletedAt = new Date().toISOString();
    const targets = activeItems
      .filter((item) => item.phone === lead.phone && !item.deleted_at)
      .map((item) => ({ id: item.id, fields: { deleted_at: deletedAt } as Partial<Lead> }));

    if (openId === id) setOpenId(null);

    const saved = await mutateLeads(targets, () => deleteLeadRequest(id));

    if (saved && !sampleMode) {
      if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
      setUndoableDelete({ leadId: id, label: lead.name || "Lead" });
      undoTimerRef.current = window.setTimeout(() => setUndoableDelete(null), UNDO_DELETE_MS);
    }
  }

  // Restoring brings the whole caller back. When the owner picks a status it
  // lands on the newest row (the one the inbox shows); a plain undo keeps the
  // status the lead already had.
  async function restoreLead(id: string, status?: LeadStatus) {
    const lead = leadById(id);
    if (!lead) return;

    const targets = activeItems
      .filter((item) => item.phone === lead.phone && item.deleted_at)
      .map((item) => ({
        id: item.id,
        fields: {
          deleted_at: null,
          ...(status && item.id === id ? { status } : {}),
        } as Partial<Lead>,
      }));

    await mutateLeads(targets, () => patchLead(id, { deleted: false, ...(status ? { status } : {}) }));
  }

  function dismissUndo() {
    if (undoTimerRef.current) window.clearTimeout(undoTimerRef.current);
    setUndoableDelete(null);
  }

  async function undoDelete() {
    if (!undoableDelete) return;
    const { leadId } = undoableDelete;
    dismissUndo();
    await restoreLead(leadId);
  }

  async function updateName(id: string, name: string | null) {
    const currentLead = leadById(id);
    if (!currentLead) return;

    const phone = currentLead.phone;

    if (sampleMode) {
      setSampleItems((current) => current.map((lead) => (lead.phone === phone ? { ...lead, name } : lead)));
      return;
    }

    // Names fan out across every row for the phone (the server does the same),
    // so the pending write is keyed by phone rather than lead id.
    const previousName = currentLead.name;
    recordPendingWrite(pendingPhoneWrites.current, phone, { name });
    setItems((current) => current.map((lead) => (lead.phone === phone ? { ...lead, name } : lead)));

    const saved = await patchLead(id, { name });

    if (!saved) {
      discardPendingWrite(pendingPhoneWrites.current, phone, ["name"]);
      setItems((current) => current.map((lead) => (lead.phone === phone ? { ...lead, name: previousName } : lead)));
    }
  }

  async function updateBooked(id: string, booked: boolean) {
    const currentLead = leadById(id);
    const bookedAt = booked ? currentLead?.booked_at ?? new Date().toISOString() : null;
    const jobValueCents = booked ? currentLead?.job_value_cents ?? null : null;

    await mutateLeads(
      [{ id, fields: { booked_at: bookedAt, job_value_cents: jobValueCents } }],
      () => patchLead(id, { booked, jobValueCents }),
    );
  }

  async function updateNotes(id: string, notes: string) {
    await mutateLeads([{ id, fields: { notes } }], () => patchLead(id, { notes }));
  }

  async function updateVoicemailSummary(id: string, voicemailSummary: string) {
    const normalizedSummary = voicemailSummary.trim() || null;

    await mutateLeads(
      [{ id, fields: { voicemail_summary: normalizedSummary } }],
      () => patchLead(id, { voicemailSummary: normalizedSummary }),
    );
  }

  async function updateJobValue(id: string, jobValueCents: number | null) {
    const currentLead = leadById(id);
    const shouldMarkBooked = Boolean(jobValueCents && jobValueCents > 0 && !currentLead?.booked_at);

    await mutateLeads(
      [
        {
          id,
          fields: {
            job_value_cents: jobValueCents,
            ...(shouldMarkBooked ? { booked_at: new Date().toISOString() } : {}),
          },
        },
      ],
      () =>
        patchLead(id, {
          ...(shouldMarkBooked ? { booked: true } : {}),
          jobValueCents,
        }),
    );
  }

  async function updatePriority(id: string, replyPriorityOverride: ReplyPriorityOverride) {
    await mutateLeads(
      [{ id, fields: { reply_priority_override: replyPriorityOverride } }],
      () => patchLead(id, { replyPriorityOverride }),
    );
  }

  async function transcribeVoicemail(id: string) {
    if (sampleMode) {
      updateLocalLead(id, {
        voicemail_transcript: "The caller needs help with a kitchen sink backup and wants service today if possible.",
        voicemail_summary: "Kitchen sink backup; wants service today if possible.",
        voicemail_transcription_status: "completed",
        voicemail_transcription_error: null,
        voicemail_transcribed_at: new Date().toISOString(),
      });
      return;
    }

    setTranscribingIds((current) => new Set(current).add(id));
    updateLocalLead(id, {
      voicemail_transcription_status: "processing",
      voicemail_transcription_error: null,
    });

    const result = await requestVoicemailSummary(id);

    if (result.ok) {
      // Server truth: the transcription is persisted before this response, so
      // any refresh from here on carries the same data.
      updateLocalLead(id, {
        voicemail_transcript: result.data.transcript,
        voicemail_summary: result.data.summary,
        voicemail_transcription_status: result.data.status,
        voicemail_transcription_error: null,
        voicemail_transcribed_at: new Date().toISOString(),
      });
    } else {
      updateLocalLead(id, {
        voicemail_transcription_status: "failed",
        voicemail_transcription_error: result.error,
      });
    }

    setTranscribingIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  }

  function appendOutboundReply(id: string, message: OutboundMessage) {
    const setter = sampleMode ? setSampleItems : setItems;
    setter((current) =>
      current.map((lead) =>
        lead.id === id
          ? {
              ...lead,
              status: lead.status === "new" ? ("contacted" as LeadStatus) : lead.status,
              outbound_messages: [message, ...lead.outbound_messages],
            }
          : lead,
      ),
    );
  }

  async function sendReply(id: string, body: string): Promise<SendReplyResult> {
    if (sampleMode) {
      const message: OutboundMessage = {
        id: `sample-reply-${Date.now()}`,
        lead_id: id,
        twilio_message_sid: null,
        from_phone: null,
        to_phone: null,
        body,
        status: "sent",
        created_at: new Date().toISOString(),
      };
      appendOutboundReply(id, message);
      return { ok: true, message };
    }

    const result = await sendLeadReply(id, body);

    if (result.ok) {
      // The reply route marks the lead contacted server-side; remember the
      // optimistic flip so a stale refresh can't briefly snap it back to New.
      const lead = items.find((item) => item.id === id);
      if (lead?.status === "new") {
        recordPendingWrite(pendingLeadWrites.current, id, { status: "contacted" });
      }
      appendOutboundReply(id, result.message);
      router.refresh();
    }

    return result;
  }

  return {
    activeItems,
    counts,
    deleteLead,
    dismissUndo,
    sendReply,
    phoneCallCounts: callCounts,
    expandedLeadIds,
    filter,
    filteredItems,
    now,
    openLead,
    query,
    sampleMode,
    searchRef,
    sortedItems,
    transcribingIds,
    undoableDelete,
    undoDelete,
    refreshInbox: () => router.refresh(),
    setFilter,
    setOpenId,
    setQuery,
    toggleLeadDetails,
    toggleSampleMode: () => {
      setSampleMode((value) => !value);
      setOpenId(null);
    },
    restoreLead,
    transcribeVoicemail,
    updateBooked,
    updateJobValue,
    updateName,
    updateNotes,
    updatePriority,
    updateStatus,
    updateVoicemailSummary,
  };
}
