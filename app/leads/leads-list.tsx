"use client";

import Link from "next/link";
import { Icon } from "@/components/icon";
import type { Lead } from "@/lib/supabase";
import type { ForwardingHealthSummary } from "@/lib/forwarding-health";
import { FILTERS } from "./_constants";
import { ForwardingHealthCard } from "./_components/forwarding-health-card";
import { LeadCard } from "./_components/lead-card";
import { LeadDrawer } from "./_components/lead-drawer";
import { SmsHealthCard } from "./_components/sms-health-card";
import { useLeadsInbox } from "./_hooks/use-leads-inbox";
import { useRouter } from "next/navigation";

export function LeadsList({
  leads,
  businessName,
  forwardingHealth,
}: {
  leads: Lead[];
  businessName: string;
  forwardingHealth: ForwardingHealthSummary;
}) {
  const router = useRouter();
  const inbox = useLeadsInbox(leads);

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
          <div className="search">
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

      <details
        className="panel"
        style={{ marginBottom: 16, padding: "10px 14px" }}
        open={forwardingHealth.displayStatus === "failed"}
      >
        <summary style={{ cursor: "pointer", fontSize: 13.5 }}>
          <Icon
            name={forwardingHealth.displayStatus === "failed" ? "alertTriangle" : "check"}
            size={13}
          />{" "}
          Line health{" "}
          <span style={{ color: "var(--ink-4)" }}>
            — {forwardingHealth.displayStatus === "failed"
              ? "forwarding problem detected"
              : forwardingHealth.statusLabel}
          </span>
        </summary>
        <div style={{ marginTop: 12 }}>
          <ForwardingHealthCard initialSummary={forwardingHealth} />
          <SmsHealthCard />
        </div>
      </details>

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

      <div className="leads-list">
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
