"use client";

import Link from "next/link";
import { Icon } from "@/components/icon";
import type { Lead, LeadInboxCounts, LeadInboxFilter } from "@/lib/supabase";
import { FILTERS } from "./_constants";
import { LeadCard } from "./_components/lead-card";
import { LeadDrawer } from "./_components/lead-drawer";
import { useLeadsInbox } from "./_hooks/use-leads-inbox";
import { useRouter } from "next/navigation";

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
  const router = useRouter();
  const inbox = useLeadsInbox(leads, {
    counts,
    callCounts,
    filter: pagination.filter,
    query: pagination.query,
  });
  const businessInitial = businessName.trim().charAt(0).toUpperCase() || "R";
  const loadedStart = leads.length > 0 ? pagination.offset + 1 : 0;
  const loadedEnd = pagination.offset + leads.length;
  const knownTotal = pagination.total ?? null;
  const hasPreviousPage = pagination.page > 1;
  const hasNextPage = knownTotal === null
    ? leads.length === pagination.limit
    : loadedEnd < knownTotal;

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
      <header className="app-head">
        <Link className="app-head__brand app-head__brand--link" href="/">
          <div className="brand-mark"><Icon name="relay" size={18} /></div>
          <div>
            <p className="t-eyebrow" style={{ fontSize: 10 }}>Relay NW</p>
            <h1 className="t-display" style={{ fontSize: 22, margin: 0 }}>{businessName}</h1>
          </div>
          <span className="live-dot" title="Auto-refreshes every few seconds">
            <span className="live-dot__pulse" />
            <span className="live-dot__core" />
            Live
          </span>
        </Link>

        <div className="app-head__right">
          <div className="search app-head__desktop-search">
            <Icon name="search" size={14} />
            <input
              ref={inbox.searchRef}
              className="search__input"
              placeholder="Search name, phone, message..."
              value={inbox.query}
              onChange={(event) => inbox.setQuery(event.target.value)}
            />
            <span className="kbd">⌘K</span>
          </div>
          <Link className="btn btn-secondary btn-sm" href="/reports">
            Reports
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/setup">
            Setup
          </Link>
          <Link className="btn btn-secondary btn-sm" href="/settings">
            Settings
          </Link>
          {inbox.sampleMode || inbox.activeItems.length === 0 ? (
            <button
              className={`btn btn-secondary btn-sm app-head__sample ${inbox.sampleMode ? "btn-sample-on" : ""}`}
              type="button"
              onClick={inbox.toggleSampleMode}
            >
              Sample data
            </button>
          ) : null}
          <form className="app-head__logout" action="/api/leads-logout" method="POST">
            <button className="btn btn-secondary btn-sm">Log out</button>
          </form>

          <details className="mobile-owner-menu">
            <summary className="mobile-owner-menu__trigger" aria-label="Open account menu">
              <span>{businessInitial}</span>
              <Icon name="more" size={16} />
            </summary>
            <div className="mobile-owner-menu__panel">
              <div className="mobile-owner-menu__profile">
                <div className="mobile-owner-menu__avatar">{businessInitial}</div>
                <div>
                  <p>{businessName}</p>
                  <span>Missed-call inbox</span>
                </div>
              </div>
              <Link className="mobile-owner-menu__item" href="/setup">
                <Icon name="settings" size={15} />
                Setup
              </Link>
              <Link className="mobile-owner-menu__item" href="/reports">
                <Icon name="inbox" size={15} />
                Reports
              </Link>
              <Link className="mobile-owner-menu__item" href="/settings">
                <Icon name="user" size={15} />
                Settings
              </Link>
              {inbox.sampleMode || inbox.activeItems.length === 0 ? (
                <button
                  className="mobile-owner-menu__item"
                  type="button"
                  onClick={inbox.toggleSampleMode}
                >
                  <Icon name="sparkle" size={15} />
                  {inbox.sampleMode ? "Hide sample data" : "Sample data"}
                </button>
              ) : null}
              <form action="/api/leads-logout" method="POST">
                <button className="mobile-owner-menu__item mobile-owner-menu__item--muted" type="submit">
                  <Icon name="external" size={15} />
                  Log out
                </button>
              </form>
            </div>
          </details>
        </div>
      </header>

      <section className="page-head">
        <div>
          <p className="t-eyebrow">Inbox</p>
          <h2 className="t-display page-head__title">
            {inbox.counts.actionable > 0 ? (
              <>You have <em>{inbox.counts.actionable}</em> {inbox.counts.actionable === 1 ? "lead" : "leads"} to work.</>
            ) : (
              <>Inbox is clear. Nice work.</>
            )}
          </h2>
        </div>
      </section>

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

      <div className="inbox-page-meta">
        <span>
          {knownTotal === null
            ? `Showing ${leads.length} most recent loaded leads`
            : leads.length > 0
              ? `Showing ${loadedStart}-${loadedEnd} of ${knownTotal} leads`
              : "No leads loaded"}
        </span>
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

      <div className={`leads-list ${inbox.isSearching ? "leads-list--loading" : ""}`} aria-busy={inbox.isSearching}>
        {inbox.sortedItems.map((lead) => (
          <LeadCard
            key={lead.id}
            lead={lead}
            now={inbox.now}
            callCount={inbox.phoneCallCounts.get(lead.phone) ?? 1}
            onOpen={(id) => (id.startsWith("sample-") ? inbox.setOpenId(id) : router.push(`/leads/${id}`))}
            onStatus={inbox.updateStatus}
            onBooked={inbox.updateBooked}
            onJobValue={inbox.updateJobValue}
            onDelete={inbox.deleteLead}
            onRestore={inbox.restoreLead}
            expanded={inbox.expandedLeadIds.has(lead.id)}
            onToggleDetails={inbox.toggleLeadDetails}
          />
        ))}

        {inbox.filteredItems.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state__icon"><Icon name="inbox" size={28} /></div>
            <h3 className="t-display" style={{ fontSize: 24, margin: "12px 0 4px" }}>
              {inbox.filter === "trash"
                ? "Trash is empty."
                : inbox.activeItems.length === 0
                  ? "No missed calls yet."
                  : "No leads in this view."}
            </h3>
            <p style={{ color: "var(--ink-3)", margin: 0 }}>
              {inbox.filter === "trash"
                ? "Deleted leads will appear here so you can restore them if you make a mistake."
                : inbox.activeItems.length === 0
                  ? "Once someone calls and you miss it, Relay NW will save the caller, voicemail, and follow-up status here."
                  : "Try another status filter or wait for new missed calls to come in."}
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
