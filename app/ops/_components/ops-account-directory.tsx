import Link from "next/link";
import type { OpsAccountSummary } from "@/lib/supabase";
import { getOpsLifecycle, type OpsLifecycleStage } from "@/lib/ops-lifecycle";

const FILTERS: Array<{ key: OpsLifecycleStage | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "setting_up", label: "Setting up" },
  { key: "live", label: "Live" },
  { key: "active", label: "Active" },
  { key: "paused", label: "Paused" },
  { key: "closed", label: "Closed" },
  { key: "canceled", label: "Canceled" },
];

function formatDays(days: number | null) {
  return days === null ? "day count unavailable" : `day ${days}`;
}

function tone(stage: OpsLifecycleStage, billingStatus: string) {
  if (billingStatus === "past_due") return "lead-card--attention";
  if (stage === "live") return "lead-card--fast";
  if (stage === "active") return "lead-card--good";
  return "";
}

function stagePillTone(stage: OpsLifecycleStage) {
  if (stage === "active") return "booked";
  if (stage === "live") return "new";
  return "contacted";
}

function manuallySettableStage(stage: OpsLifecycleStage) {
  return stage === "setting_up" || stage === "paused" || stage === "closed" ? stage : "";
}

export function OpsAccountDirectory({
  accounts,
  query,
  stage = "all",
}: {
  accounts: OpsAccountSummary[];
  query: string;
  stage?: OpsLifecycleStage | "all";
}) {
  const rows = accounts.map((account) => ({ account, lifecycle: getOpsLifecycle({
    onboardingStatus: account.onboardingStatus,
    billingStatus: account.billingStatus,
    activatedAt: account.activatedAt,
    cancelAtPeriodEnd: account.cancelAtPeriodEnd,
    currentPeriodEnd: account.currentPeriodEnd,
    updatedAt: account.billingUpdatedAt ?? account.updatedAt,
  }) })).filter(({ lifecycle }) => stage === "all" || lifecycle.stage === stage);
  const counts = new Map<string, number>();
  for (const account of accounts) {
    const lifecycle = getOpsLifecycle({
      onboardingStatus: account.onboardingStatus,
      billingStatus: account.billingStatus,
      activatedAt: account.activatedAt,
      cancelAtPeriodEnd: account.cancelAtPeriodEnd,
      currentPeriodEnd: account.currentPeriodEnd,
      updatedAt: account.billingUpdatedAt ?? account.updatedAt,
    });
    counts.set(lifecycle.stage, (counts.get(lifecycle.stage) ?? 0) + 1);
  }

  return (
    <>
      <form className="lead-controls ops-account-search" action="/ops">
        <input className="field" name="q" defaultValue={query} placeholder="Search business or owner" aria-label="Search accounts" />
        <button className="btn btn-primary" type="submit">Search</button>
      </form>

      <nav className="filters clean-scroll" aria-label="Filter customer pipeline">
        {FILTERS.map((item) => (
          <Link key={item.key} className={`filter-pill ${stage === item.key ? "filter-pill--on" : ""}`} href={`/ops?${new URLSearchParams({ ...(query ? { q: query } : {}), ...(item.key !== "all" ? { stage: item.key } : {}) }).toString()}`}>
            {item.label}<span className="filter-pill__count">{item.key === "all" ? accounts.length : counts.get(item.key) ?? 0}</span>
          </Link>
        ))}
      </nav>

      <section className="ops-attention-grid" aria-label="Needs attention">
        {accounts.filter((account) => account.billingStatus === "past_due").map((account) => (
          <Link className="ops-attention-row" key={account.accountId} href={`/ops/accounts/${encodeURIComponent(account.accountSlug)}`}>
            <span className="ops-attention-row__dot" />
            <span><strong>Payment failed</strong><small>{account.businessName} needs a billing check</small></span>
            <span className="ops-attention-row__arrow">→</span>
          </Link>
        ))}
      </section>

      <div className="ops-account-grid">
        {rows.length === 0 ? (
          <article className="empty-state">
            <div className="empty-state__icon">✓</div>
            <h2 className="t-display">Nothing needs you here.</h2>
            <p>Try another stage or clear the search.</p>
          </article>
        ) : rows.map(({ account, lifecycle }) => (
          <article className={`lead-card ops-account-card ${tone(lifecycle.stage, account.billingStatus)}`} key={account.accountId}>
            <div className="lead-card__head">
              <div>
                <p className="lead-card__id">{account.accountSlug}</p>
                <h2 className="lead-card__name">{account.businessName}</h2>
                <p className="lead-card__meta"><span>{lifecycle.label}</span><span>{formatDays(lifecycle.daysInStage)}</span><span>{account.ownerEmail ?? "Owner not set"}</span></p>
              </div>
              <span className={`lead-card__status-pill lead-card__status-pill--${stagePillTone(lifecycle.stage)}`}>{lifecycle.label}</span>
            </div>
            <section className="lead-card__request lead-card__request--summary">
              <div className="lead-card__request-label">Next step</div>
              <p>{account.billingStatus === "past_due" ? "Payment failed — open Billing Portal." : lifecycle.blockedOn}</p>
            </section>
            <div className="lead-card__actions">
              <div className="lead-card__primary-actions">
                <Link className="btn btn-primary btn-sm" href={`/ops/accounts/${encodeURIComponent(account.accountSlug)}`}>
                  {account.billingStatus === "past_due" ? "Resolve payment" : lifecycle.primaryAction}
                </Link>
              </div>
              <div className="lead-card__utility-actions">
                <form action="/api/ops/stage" method="post" className="ops-stage-move">
                  <input type="hidden" name="account_slug" value={account.accountSlug} />
                  <select className="field" name="stage" defaultValue={manuallySettableStage(lifecycle.stage)} aria-label={`Move ${account.businessName} to stage`}>
                    <option value="" disabled>Move manually…</option>
                    <option value="setting_up">Setting up</option>
                    <option value="paused">Paused</option>
                    <option value="closed">Closed</option>
                  </select>
                  <button className="btn btn-ghost btn-sm" type="submit">Move</button>
                </form>
                <Link className="btn btn-ghost btn-sm" href={`/ops/accounts/${encodeURIComponent(account.accountSlug)}#diagnostics`}>Diagnostics</Link>
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
