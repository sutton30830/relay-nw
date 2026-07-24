import Link from "next/link";
import type { OpsAccountSummary } from "@/lib/supabase";
import {
  deriveOpsState,
  type OpsDerivedState,
  type OpsQueueGroup,
} from "@/lib/ops-state";

const FILTERS: Array<{ key: OpsQueueGroup | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "needs_attention", label: "Needs attention" },
  { key: "onboarding", label: "Onboarding" },
  { key: "running", label: "Running" },
  { key: "paused", label: "Paused" },
];

function deriveAccountState(account: OpsAccountSummary) {
  return deriveOpsState({
    technicalStatus: account.technicalStatus,
    a2pStatus: account.a2pStatus,
    smsEnabled: account.smsEnabled,
    billingStatus: account.billingStatus,
    billingPolicy: account.billingPolicy,
    stripeSubscriptionStatus: account.stripeSubscriptionStatus,
    setupFeeStatus: account.setupFeeStatus,
    stripeDefaultPaymentMethodId: account.stripeDefaultPaymentMethodId,
    cancelAtPeriodEnd: account.cancelAtPeriodEnd,
    blockedBy: account.opsBlockedBy,
    blockerNote: account.opsBlockerNote,
    blockedSince: account.opsBlockedSince,
  });
}

function tone(state: OpsDerivedState) {
  if (state.queueGroup === "needs_attention") return "lead-card--attention";
  if (state.queueGroup === "running") return "lead-card--good";
  if (state.calls === "ready") return "lead-card--fast";
  return "";
}

function queuePillTone(queue: OpsQueueGroup) {
  if (queue === "running") return "booked";
  if (queue === "needs_attention") return "contacted";
  if (queue === "onboarding") return "new";
  return "contacted";
}

function blockedAge(state: OpsDerivedState) {
  if (state.blockedBy === "none") return "No blocker";
  if (state.blockedAgeDays === null) return `Blocked by ${state.labels.blocker}`;
  return `Blocked by ${state.labels.blocker} · ${state.blockedAgeDays}d`;
}

export function OpsAccountDirectory({
  accounts,
  query,
  queue = "all",
}: {
  accounts: OpsAccountSummary[];
  query: string;
  queue?: OpsQueueGroup | "all";
}) {
  const derived = accounts.map((account) => ({
    account,
    state: deriveAccountState(account),
  }));
  const rows = derived.filter(({ state }) =>
    queue === "all" || state.queueGroup === queue);
  const counts = new Map<OpsQueueGroup, number>();
  for (const { state } of derived) {
    counts.set(state.queueGroup, (counts.get(state.queueGroup) ?? 0) + 1);
  }

  return (
    <>
      <form className="lead-controls ops-account-search" action="/ops">
        <input
          className="field"
          name="q"
          defaultValue={query}
          placeholder="Search business or owner"
          aria-label="Search accounts"
        />
        <button className="btn btn-primary" type="submit">Search</button>
      </form>

      <nav className="filters clean-scroll" aria-label="Filter Operations queue">
        {FILTERS.map((item) => (
          <Link
            key={item.key}
            className={`filter-pill ${queue === item.key ? "filter-pill--on" : ""}`}
            href={`/ops?${new URLSearchParams({
              ...(query ? { q: query } : {}),
              ...(item.key !== "all" ? { queue: item.key } : {}),
            }).toString()}`}
          >
            {item.label}
            <span className="filter-pill__count">
              {item.key === "all" ? accounts.length : counts.get(item.key) ?? 0}
            </span>
          </Link>
        ))}
      </nav>

      <section className="ops-attention-grid" aria-label="Needs attention">
        {derived
          .filter(({ state }) => state.queueGroup === "needs_attention")
          .map(({ account, state }) => (
            <Link
              className="ops-attention-row"
              key={account.accountId}
              href={`/ops/accounts/${encodeURIComponent(account.accountSlug)}`}
            >
              <span className="ops-attention-row__dot" />
              <span>
                <strong>{state.nextAction.label}</strong>
                <small>{account.businessName} · {blockedAge(state)}</small>
              </span>
              <span className="ops-attention-row__arrow">→</span>
            </Link>
          ))}
      </section>

      <div className="ops-account-grid">
        {rows.length === 0 ? (
          <article className="empty-state">
            <div className="empty-state__icon">✓</div>
            <h2 className="t-display">Nothing needs you here.</h2>
            <p>Try another queue or clear the search.</p>
          </article>
        ) : rows.map(({ account, state }) => (
          <article
            className={`lead-card ops-account-card ${tone(state)}`}
            key={account.accountId}
          >
            <div className="lead-card__head">
              <div>
                <p className="lead-card__id">{account.accountSlug}</p>
                <h2 className="lead-card__name">{account.businessName}</h2>
                <p className="lead-card__meta">
                  <span>{state.queueLabel}</span>
                  <span>{blockedAge(state)}</span>
                  <span>{account.ownerEmail ?? "Owner not set"}</span>
                </p>
              </div>
              <span className={`lead-card__status-pill lead-card__status-pill--${queuePillTone(state.queueGroup)}`}>
                {state.queueLabel}
              </span>
            </div>

            <dl className="webhook-event__meta" aria-label="Independent account statuses">
              <div><dt>Calls</dt><dd>{state.labels.calls}</dd></div>
              <div><dt>Texting</dt><dd>{state.labels.texting}</dd></div>
              <div><dt>Billing</dt><dd>{state.labels.billing}</dd></div>
              <div><dt>Blocked by</dt><dd>{state.labels.blocker}</dd></div>
            </dl>

            <section className="lead-card__request lead-card__request--summary">
              <div className="lead-card__request-label">Next action</div>
              <p><strong>{state.nextAction.label}</strong></p>
              <p>{state.nextAction.detail}</p>
            </section>

            <div className="lead-card__actions">
              <div className="lead-card__primary-actions">
                <Link
                  className="btn btn-primary btn-sm"
                  href={`/ops/accounts/${encodeURIComponent(account.accountSlug)}`}
                >
                  Open account
                </Link>
              </div>
              <div className="lead-card__utility-actions">
                <Link
                  className="btn btn-ghost btn-sm"
                  href={`/ops/accounts/${encodeURIComponent(account.accountSlug)}#diagnostics`}
                >
                  Diagnostics
                </Link>
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
