"use client";

import Link from "next/link";
import { Icon } from "@/components/icon";
import type { Lead, LeadInboxCounts, LeadInboxFilter } from "@/lib/supabase";
import { FILTERS } from "./_constants";
import { AppHeader } from "./_components/app-header";
import { LeadCard } from "./_components/lead-card";
import { LeadDrawer } from "./_components/lead-drawer";
import { useLeadsInbox } from "./_hooks/use-leads-inbox";

export function LeadsList({
  leads,
  businessName,
  counts,
  callCounts,
  pagination,
}: {
  leads: Lead[];
  businessName: string;
  counts: LeadInboxCounts;
  callCounts: Record<string, number>;
  pagination: {
    page: number;
    limit: number;
    offset: number;
    total: number | null;
    filter: LeadInboxFilter;
    query: string;
  };
}) {
  const inbox = useLeadsInbox(leads, {
    counts,
    callCounts,
    filter: pagination.filter,
    query: pagination.query,
  });
  const loadedEnd = pagination.offset + leads.length;
  const knownTotal = pagination.total ?? null;
  const hasPreviousPage = pagination.page > 1;
  const hasNextPage = knownTotal === null
    ? leads.length === pagination.limit
    : loadedEnd < knownTotal;
  const trimmedQuery = inbox.query.trim();
  const hasSearch = trimmedQuery.length > 0;
  const accountHasAnyLeads = inbox.counts.all + inbox.counts.trash > 0;
  const activeFilter = FILTERS.find((item) => item.key === inbox.filter);
  const emptyStateTitle = hasSearch
    ? `No leads match "${trimmedQuery}".`
    : !accountHasAnyLeads
      ? "No missed calls yet."
      : inbox.filter === "trash"
        ? "Trash is empty."
        : inbox.filter !== "all"
          ? `No ${activeFilter?.label.toLowerCase() ?? "matching"} leads.`
          : "No leads in this view.";
  const emptyStateCopy = hasSearch
    ? "There are leads in the inbox — this keyword just does not match them. Clear the search or try a different word."
    : !accountHasAnyLeads
      ? "Once someone calls and you miss it, Relay NW will save the caller, voicemail, and follow-up status here."
      : inbox.filter === "trash"
        ? "Deleted leads will appear here so you can restore them if you make a mistake."
        : "Try another status filter or wait for new missed calls to come in.";

  // Preserves the active filter/search across pagination. Sample mode has no
  // server pagination, so these links only appear in real mode where the URL is
  // the source of truth.
  function pageHref(page: number) {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    if (pagination.filter !== "all") params.set("filter", pagination.filter);
    if (pagination.query) params.set("q", pagination.query);
    const qs = params.toString();
    return qs ? `/leads?${qs}` : "/leads";
  }

  return (
    <>
      <AppHeader
        businessName={businessName}
        currentPage="inbox"
        search={{
          inputRef: inbox.searchRef,
          onChange: inbox.setQuery,
          placeholder: "Search name, phone, message...",
          value: inbox.query,
        }}
        sample={{
          active: inbox.sampleMode,
          label: "Sample data",
          onToggle: inbox.toggleSampleMode,
          visible: inbox.sampleMode || inbox.activeItems.length === 0,
        }}
      />

      <div className="mobile-inbox-search">
        <div className="search">
          <Icon name="search" size={14} />
          <input
            className="search__input"
            placeholder="Search leads..."
            value={inbox.query}
            onChange={(event) => inbox.setQuery(event.target.value)}
          />
        </div>
      </div>

      <nav className="filters clean-scroll" aria-label="Filter leads">
        {FILTERS.map((item) => {
          const count = inbox.counts[item.key];
          const active = inbox.filter === item.key;
          return (
            <button
              key={item.key}
              type="button"
              className={`filter-pill ${active ? "filter-pill--on" : ""}`}
              onClick={() => inbox.setFilter(item.key)}
              aria-pressed={active}
            >
              {item.label}
              <span className="filter-pill__count">{count}</span>
            </button>
          );
        })}
      </nav>

      {hasPreviousPage || hasNextPage ? (
        <div className="inbox-page-meta">
          <div className="inbox-page-meta__actions">
            {hasPreviousPage ? (
              <Link className="btn btn-secondary btn-sm" href={pageHref(pagination.page - 1)}>
                Previous
              </Link>
            ) : null}
            {hasNextPage ? (
              <Link className="btn btn-secondary btn-sm" href={pageHref(pagination.page + 1)}>
                Next
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className={`leads-list ${inbox.isSearching ? "leads-list--loading" : ""}`} aria-busy={inbox.isSearching}>
        {inbox.sortedItems.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            now={inbox.now}
            callCount={inbox.phoneCallCounts.get(lead.phone) ?? 1}
            // Real leads navigate to their conversation page via a real link
            // (keyboard, middle-click, prefetch); sample leads have no page, so
            // they fall back to opening the in-memory drawer through onOpen.
            href={lead.id.startsWith("sample-") ? undefined : `/leads/${lead.id}`}
            isOpening={inbox.openingLeadId === lead.id}
            onOpen={inbox.openLeadConversation}
            onPrefetch={inbox.prefetchLeadConversation}
            onStatus={inbox.updateStatus}
            onBooked={inbox.updateBooked}
            onJobValue={inbox.updateJobValue}
            onDelete={inbox.deleteLead}
            onRestore={inbox.restoreLead}
          />
        ))}

        {inbox.filteredItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon"><Icon name="inbox" size={28} /></div>
            <h3 className="t-display" style={{ fontSize: 24, margin: "12px 0 4px" }}>
              {emptyStateTitle}
            </h3>
            <p style={{ color: "var(--ink-3)", margin: 0 }}>
              {emptyStateCopy}
            </p>
          </div>
        ) : null}
      </div>

      {inbox.undoableDelete ? (
        <div className="undo-toast" role="status">
          <span className="undo-toast__text">{inbox.undoableDelete.label} moved to Trash.</span>
          <button className="undo-toast__action" type="button" onClick={() => void inbox.undoDelete()}>
            Undo
          </button>
          <button className="undo-toast__dismiss" type="button" aria-label="Dismiss" onClick={inbox.dismissUndo}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ) : null}

      {/* Real leads open the full conversation page (/leads/[id]); the drawer is
          the detail view for sample data only, which has no server-side page. */}
      {inbox.openLead ? (
        <LeadDrawer
          key={inbox.openLead.id}
          lead={inbox.openLead}
          previousLeads={inbox.activeItems
            .filter(
              (lead) =>
                lead.phone === inbox.openLead!.phone &&
                lead.id !== inbox.openLead!.id &&
                !lead.deleted_at,
            )
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())}
          onClose={() => inbox.setOpenId(null)}
          onStatus={inbox.updateStatus}
          onBooked={inbox.updateBooked}
          onName={inbox.updateName}
          onNotes={inbox.updateNotes}
          onSummary={inbox.updateVoicemailSummary}
          onJobValue={inbox.updateJobValue}
          onPriority={inbox.updatePriority}
          onTranscribe={inbox.transcribeVoicemail}
          onReply={inbox.sendReply}
          isTranscribing={inbox.transcribingIds.has(inbox.openLead.id)}
        />
      ) : null}
    </>
  );
}
