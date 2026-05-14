"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lead, LeadStatus, ReplyPriorityOverride } from "@/lib/supabase";
import { AUTO_VOICEMAIL_SUMMARY_LIMIT, INBOX_REFRESH_MS, RELATIVE_TIME_TICK_MS } from "../_constants";
import type { Filter } from "../_types";
import { deleteLead as deleteLeadRequest, patchLead, requestVoicemailSummary } from "../_api";
import { countLeads, createSampleLeads, filterLeads, shouldAutoSummarizeVoicemail, sortLeadsForWork } from "../_utils";

export function useLeadsInbox(leads: Lead[]) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const initiallyLoadedLeadIds = useRef<Set<string>>(new Set(leads.map((lead) => lead.id)));
  const autoSummaryStartedIds = useRef<Set<string>>(new Set());
  const pendingPriorityOverrides = useRef<Map<string, ReplyPriorityOverride>>(new Map());
  const [items, setItems] = useState(leads);
  const [sampleItems, setSampleItems] = useState(() => createSampleLeads());
  const [sampleMode, setSampleMode] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [transcribingIds, setTranscribingIds] = useState<Set<string>>(() => new Set());
  const [expandedLeadIds, setExpandedLeadIds] = useState<Set<string>>(() => new Set());
  const activeItems = sampleMode ? sampleItems : items;

  useEffect(() => {
    setItems(applyPendingPriorityOverrides(leads));
    if (leads.length > 0) setSampleMode(false);
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

  const counts = useMemo(() => countLeads(activeItems), [activeItems]);
  const filteredItems = useMemo(
    () => filterLeads(activeItems, filter, query),
    [activeItems, filter, query],
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

  function applyPendingPriorityOverrides(nextItems: Lead[]) {
    if (pendingPriorityOverrides.current.size === 0) {
      return nextItems;
    }

    return nextItems.map((lead) => {
      if (!pendingPriorityOverrides.current.has(lead.id)) {
        return lead;
      }

      return {
        ...lead,
        reply_priority_override: pendingPriorityOverrides.current.get(lead.id) ?? null,
      };
    });
  }

  function updateLocalLeadsByPhone(phone: string, updates: Partial<Lead>) {
    const setter = sampleMode ? setSampleItems : setItems;
    setter((current) => current.map((lead) => (lead.phone === phone ? { ...lead, ...updates } : lead)));
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

  async function updateStatus(id: string, status: LeadStatus) {
    if (sampleMode) {
      updateLocalLead(id, { status });
      return;
    }

    const previousItems = items;
    updateLocalLead(id, { status });

    const saved = await patchLead(id, { status });
    if (!saved) setItems(previousItems);
  }

  async function deleteLead(id: string) {
    const deletedAt = new Date().toISOString();

    if (sampleMode) {
      updateLocalLead(id, { deleted_at: deletedAt });
      if (openId === id) setOpenId(null);
      return;
    }

    const previousItems = items;
    const previousOpenId = openId;
    updateLocalLead(id, { deleted_at: deletedAt });
    if (openId === id) setOpenId(null);

    const deleted = await deleteLeadRequest(id);
    if (!deleted) {
      setItems(previousItems);
      setOpenId(previousOpenId);
    }
  }

  async function restoreLead(id: string) {
    if (sampleMode) {
      updateLocalLead(id, { deleted_at: null });
      return;
    }

    const previousItems = items;
    updateLocalLead(id, { deleted_at: null });

    const saved = await patchLead(id, { deleted: false });
    if (!saved) setItems(previousItems);
  }

  async function updateName(id: string, name: string | null) {
    const currentLead = activeItems.find((lead) => lead.id === id);

    if (!currentLead) {
      return;
    }

    if (sampleMode) {
      updateLocalLeadsByPhone(currentLead.phone, { name });
      return;
    }

    const previousItems = items;
    updateLocalLeadsByPhone(currentLead.phone, { name });

    const saved = await patchLead(id, { name });
    if (!saved) setItems(previousItems);
  }

  async function updateBooked(id: string, booked: boolean) {
    const currentLead = activeItems.find((lead) => lead.id === id);
    const bookedAt = booked ? currentLead?.booked_at ?? new Date().toISOString() : null;
    const updates: Partial<Lead> = {
      booked_at: bookedAt,
      job_value_cents: booked ? currentLead?.job_value_cents ?? null : null,
    };

    if (sampleMode) {
      updateLocalLead(id, updates);
      return;
    }

    const previousItems = items;
    updateLocalLead(id, updates);

    const saved = await patchLead(id, {
      booked,
      jobValueCents: booked ? currentLead?.job_value_cents ?? null : null,
    });
    if (!saved) setItems(previousItems);
  }

  async function updateNotes(id: string, notes: string) {
    if (sampleMode) {
      updateLocalLead(id, { notes });
      return;
    }

    const previousItems = items;
    updateLocalLead(id, { notes });

    const saved = await patchLead(id, { notes });
    if (!saved) setItems(previousItems);
  }

  async function updateVoicemailSummary(id: string, voicemailSummary: string) {
    const normalizedSummary = voicemailSummary.trim() || null;

    if (sampleMode) {
      updateLocalLead(id, { voicemail_summary: normalizedSummary });
      return;
    }

    const previousItems = items;
    updateLocalLead(id, { voicemail_summary: normalizedSummary });

    const saved = await patchLead(id, { voicemailSummary: normalizedSummary });
    if (!saved) setItems(previousItems);
  }

  async function updateJobValue(id: string, jobValueCents: number | null) {
    if (sampleMode) {
      updateLocalLead(id, { job_value_cents: jobValueCents });
      return;
    }

    const previousItems = items;
    updateLocalLead(id, { job_value_cents: jobValueCents });

    const saved = await patchLead(id, { jobValueCents });
    if (!saved) setItems(previousItems);
  }

  async function updatePriority(id: string, replyPriorityOverride: ReplyPriorityOverride) {
    if (sampleMode) {
      updateLocalLead(id, { reply_priority_override: replyPriorityOverride });
      return;
    }

    const previousItems = items;
    pendingPriorityOverrides.current.set(id, replyPriorityOverride);
    updateLocalLead(id, { reply_priority_override: replyPriorityOverride });

    const saved = await patchLead(id, { replyPriorityOverride });
    pendingPriorityOverrides.current.delete(id);

    if (!saved) {
      setItems(previousItems);
    }
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

  return {
    activeItems,
    counts,
    deleteLead,
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
