"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { applyPendingWrites, applyPendingCounts, applyCountDeltas } from "../_inbox-state";
import type { Lead, LeadStatus, OutboundMessage, ReplyPriorityOverride } from "@/lib/supabase";
import { AUTO_VOICEMAIL_SUMMARY_LIMIT, FILTERS, INBOX_REFRESH_MS, RELATIVE_TIME_TICK_MS, SEARCH_DEBOUNCE_MS, UNDO_DELETE_MS } from "../_constants";
import type { Filter, LeadCounts } from "../_types";
import { deleteLead as deleteLeadRequest, patchLead, requestVoicemailSummary, sendLeadReply, type SendReplyResult } from "../_api";
import { condenseLeadsByPhone, countCallsByPhone, countLeads, createSampleLeads, filterLeads, leadDisplayName, shouldAutoSummarizeVoicemail, sortLeadsForWork } from "../_utils";

// Filter and search now run on the server (the RPC in lib/supabase/leads.ts):
// the page fetches only the rows that match the active filter/query across the
// whole account, and pushes those choices into the URL so a refetch is a normal
// navigation. The client keeps applying filterLeads/countLeads on top, but only
// as (a) the real filter for sample mode, which has no server, and (b) an
// optimistic layer so an edit that changes a lead's filter membership updates
// the view instantly instead of waiting for the next refetch.
type ServerInboxState = {
  counts: LeadCounts;
  callCounts: Record<string, number>;
  filter: Filter;
  query: string;
};

function buildInboxHref(filter: Filter, query: string) {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("filter", filter);
  if (query.trim()) params.set("q", query.trim());
  const qs = params.toString();
  return qs ? `/leads?${qs}` : "/leads";
}

type UndoableDelete = {
  leadId: string;
  label: string;
};

export function useLeadsInbox(leads: Lead[], server: ServerInboxState) {
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
  const searchDebounceRef = useRef<number | null>(null);
  const pendingQueryRef = useRef<string | null>(null);
  const [items, setItems] = useState(leads);
  const [sampleItems, setSampleItems] = useState(() => createSampleLeads());
  const [sampleMode, setSampleMode] = useState(false);
  const [filter, setFilterState] = useState<Filter>(server.filter);
  const [query, setQueryState] = useState(server.query);
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [transcribingIds, setTranscribingIds] = useState<Set<string>>(() => new Set());
  const [expandedLeadIds, setExpandedLeadIds] = useState<Set<string>>(() => new Set());
  const [undoableDelete, setUndoableDelete] = useState<UndoableDelete | null>(null);
  const [optimisticCounts, setOptimisticCounts] = useState<LeadCounts>(server.counts);
  const latestServerSnapshot = useRef({ counts: server.counts, leads });
  const [openingLeadId, setOpeningLeadId] = useState<string | null>(null);
  const [isNavigating, startNavigation] = useTransition();
  const navigationStartedRef = useRef(false);
  const navigationInFlightRef = useRef(false);
  const queuedNavigationRef = useRef<{ filter: Filter; query: string } | null>(null);
  const activeItems = sampleMode ? sampleItems : items;

  useEffect(() => {
    setItems(applyPendingWrites(leads, pendingLeadWrites.current, pendingPhoneWrites.current));
    if (leads.length > 0) setSampleMode(false);
  }, [leads]);

  // Keep local filter/query aligned with the server (the URL) so browser
  // back/forward, or a link that lands with ?filter=/?q= already set, is
  // reflected in the pills and search box. Only syncs real (non-sample) mode;
  // sample mode filters purely client-side and never touches the URL.
  useEffect(() => {
    if (sampleMode) return;
    setFilterState(server.filter);

    if (pendingQueryRef.current !== null && server.query !== pendingQueryRef.current) {
      return;
    }

    if (pendingQueryRef.current !== null && server.query === pendingQueryRef.current) {
      pendingQueryRef.current = null;
    }

    setQueryState(server.query);
  }, [server.filter, server.query, sampleMode]);

  useEffect(() => {
    if (sampleMode) return;
    // Refresh global counts even while an edit is pending. Apply only the
    // outstanding edits to rows in the authoritative page, using fresh contact
    // metadata so reclassification cannot leave stale business totals behind.
    latestServerSnapshot.current = { counts: server.counts, leads };
    setOptimisticCounts(applyPendingCounts(server.counts, leads, pendingLeadWrites.current, pendingPhoneWrites.current));
  }, [leads, server.counts, sampleMode]);

  useEffect(() => {
    if (sampleMode) return;

    for (const item of FILTERS) {
      if (item.key === filter) continue;
      router.prefetch(buildInboxHref(item.key, query));
    }
  }, [filter, query, router, sampleMode]);

  // Push the active filter/search into the URL, which refetches the matching
  // rows server-side. Filter changes navigate immediately; search is debounced
  // so we don't fire a request per keystroke. Either one drops the page param,
  // so a new filter/search starts from page 1.
  const navigateToInbox = useCallback((nextFilter: Filter, nextQuery: string) => {
    if (navigationInFlightRef.current) {
      queuedNavigationRef.current = { filter: nextFilter, query: nextQuery };
      return;
    }
    navigationInFlightRef.current = true;
    startNavigation(() => {
      router.push(buildInboxHref(nextFilter, nextQuery), { scroll: false });
    });
  }, [router]);

  function setFilter(nextFilter: Filter) {
    if (!sampleMode && (nextFilter === filter || navigationInFlightRef.current)) return;
    setFilterState(nextFilter);
    if (sampleMode) return;
    if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current);
    navigateToInbox(nextFilter, query);
  }

  // A transition can briefly report false before React begins it. Only unlock
  // category navigation after we've observed the transition start and finish,
  // preventing rapid clicks from launching competing server navigations.
  useEffect(() => {
    if (isNavigating) {
      navigationStartedRef.current = true;
      return;
    }

    if (navigationStartedRef.current) {
      navigationStartedRef.current = false;
      navigationInFlightRef.current = false;
      const queued = queuedNavigationRef.current;
      queuedNavigationRef.current = null;
      if (queued) navigateToInbox(queued.filter, queued.query);
    }
  }, [isNavigating, navigateToInbox]);

  function setQuery(nextQuery: string) {
    nextQuery = nextQuery.slice(0, 200);
    setQueryState(nextQuery);
    if (sampleMode) return;
    pendingQueryRef.current = nextQuery.trim();
    if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = window.setTimeout(() => {
      navigateToInbox(filter, nextQuery);
    }, SEARCH_DEBOUNCE_MS);
  }

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) window.clearTimeout(searchDebounceRef.current);
    };
  }, []);

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
  // is trashed or restored. Real mode uses the server's account-wide count
  // (search_lead_inbox returns it per row); sample mode has no server, so it
  // counts its own in-memory rows.
  const sampleCallCounts = useMemo(() => countCallsByPhone(sampleItems), [sampleItems]);
  const serverCallCounts = useMemo(
    () => new Map(Object.entries(server.callCounts)),
    [server.callCounts],
  );
  const callCounts = sampleMode ? sampleCallCounts : serverCallCounts;

  // One conversation per customer: live leads condense to the newest row per
  // phone, and Trash condenses the same way so a repeat caller is one card
  // there too, not a fragment per call. Real rows arrive already condensed
  // from the server, so this is a no-op there; it still does the real work for
  // sample mode's uncondensed data.
  const condensed = useMemo(
    () => condenseLeadsByPhone(activeItems.filter((lead) => !lead.deleted_at)),
    [activeItems],
  );
  const condensedTrash = useMemo(
    () => condenseLeadsByPhone(activeItems.filter((lead) => lead.deleted_at)),
    [activeItems],
  );
  // Server counts are account-wide and correct past page 1; the client count is
  // only right when it can see every lead, which is exactly sample mode.
  const sampleCounts = useMemo(
    () => countLeads([...condensed.leads, ...condensedTrash.leads]),
    [condensed, condensedTrash],
  );
  const counts = sampleMode ? sampleCounts : optimisticCounts;
  // The server already searched the complete account. Re-filtering its page
  // by client-only search fields can hide rows while leaving totals unchanged.
  const filteredItems = useMemo(
    () =>
      (sampleMode ? filter : server.filter) === "trash"
        ? filterLeads(condensedTrash.leads, sampleMode ? filter : server.filter, sampleMode ? query : "")
        : filterLeads(condensed.leads, sampleMode ? filter : server.filter, sampleMode ? query : ""),
    [condensed, condensedTrash, filter, query, sampleMode, server.filter],
  );
  const sortedItems = useMemo(
    () => sortLeadsForWork(filteredItems),
    [filteredItems],
  );

  const openLead = activeItems.find((lead) => lead.id === openId) ?? null;

  useEffect(() => {
    if (sampleMode) return;

    for (const lead of sortedItems.slice(0, 10)) {
      router.prefetch(`/leads/${lead.id}`);
    }
  }, [router, sampleMode, sortedItems]);

  useEffect(() => {
    if (!openingLeadId) return;
    const timeout = window.setTimeout(() => setOpeningLeadId(null), 8_000);
    return () => window.clearTimeout(timeout);
  }, [openingLeadId]);

  function prefetchLeadConversation(id: string) {
    if (id.startsWith("sample-")) return;
    router.prefetch(`/leads/${id}`);
  }

  function openLeadConversation(id: string) {
    if (id.startsWith("sample-")) {
      setOpenId(id);
      return;
    }

    setOpeningLeadId(id);
    prefetchLeadConversation(id);
  }

  function updateLocalLead(id: string, updates: Partial<Lead>) {
    const setter = sampleMode ? setSampleItems : setItems;
    setter((current) => current.map((lead) => (lead.id === id ? { ...lead, ...updates } : lead)));
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
    const optimisticChanges: Array<{ before: Lead; after: Lead }> = [];

    for (const target of targets) {
      const lead = items.find((item) => item.id === target.id);
      if (!lead) continue;

      const previous: Partial<Lead> = {};
      for (const key of Object.keys(target.fields) as Array<keyof Lead>) {
        (previous as Record<string, unknown>)[key] = lead[key];
      }
      previousFields.set(target.id, previous);
      recordPendingWrite(pendingLeadWrites.current, target.id, target.fields);
      optimisticChanges.push({ before: lead, after: { ...lead, ...target.fields } });
    }

    if (optimisticChanges.length > 0) {
      setOptimisticCounts((current) => applyCountDeltas(current, optimisticChanges));
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

      const latest = latestServerSnapshot.current;
      setOptimisticCounts(applyPendingCounts(latest.counts, latest.leads, pendingLeadWrites.current, pendingPhoneWrites.current));

      setItems((current) =>
        current.map((lead) => {
          const previous = previousFields.get(lead.id);
          return previous ? { ...lead, ...previous } : lead;
        }),
      );
    }

    router.refresh();
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
    // Status is an edit, not an inbox navigation. The old flow also switched
    // the entire inbox to the destination category, racing the PATCH with a
    // server render and the periodic refresh. Keep the drawer/conversation
    // stable and let the optimistic lead/count update render immediately.
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
      setUndoableDelete({ leadId: id, label: leadDisplayName(lead) || "Lead" });
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
    if (leadById(leadId)) {
      await restoreLead(leadId);
    } else {
      // A completed delete removes the row from the server page. Undo still
      // works by id; the refreshed page uses its current contact classification.
      recordPendingWrite(pendingLeadWrites.current, leadId, { deleted_at: null });
      const saved = await patchLead(leadId, { deleted: false });
      if (!saved) discardPendingWrite(pendingLeadWrites.current, leadId, ["deleted_at"]);
      router.refresh();
    }
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
        error: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
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
    isSearching: isNavigating,
    now,
    openingLeadId,
    openLead,
    openLeadConversation,
    prefetchLeadConversation,
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
