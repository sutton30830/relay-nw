import { Icon } from "@/components/icon";

function LoadingLeadCard() {
  return (
    <article className="lead-card lead-card--loading" aria-hidden="true">
      <div className="lead-card__head">
        <div className="lead-card__id">
          <div className="lead-card__avatar skeleton-pulse" />
          <div className="loading-stack">
            <span className="skeleton-line skeleton-line--title" />
            <span className="skeleton-line skeleton-line--meta" />
          </div>
        </div>
        <div className="lead-card__badges">
          <span className="skeleton-pill" />
          <span className="skeleton-pill skeleton-pill--wide" />
        </div>
      </div>

      <section className="lead-card__request">
        <div className="lead-card__request-label">
          <Icon name="message" size={13} />
          Inbox
        </div>
        <span className="skeleton-line skeleton-line--body" />
      </section>
    </article>
  );
}

export default function LeadsLoading() {
  return (
    <main className="leads-view">
      <header className="app-head">
        <div className="app-head__brand">
          <div className="brand-mark">
            <Icon name="relay" size={18} />
          </div>
          <div>
            <p className="t-eyebrow" style={{ fontSize: 10 }}>Relay NW</p>
            <h1 className="t-display" style={{ fontSize: 22, margin: 0 }}>Loading inbox</h1>
          </div>
        </div>
      </header>

      <section className="page-head">
        <div>
          <p className="t-eyebrow">Inbox</p>
          <h2 className="t-display page-head__title">Loading your latest leads...</h2>
        </div>
      </section>

      <div className="lead-list" aria-label="Loading leads">
        <LoadingLeadCard />
        <LoadingLeadCard />
      </div>
    </main>
  );
}
