import Link from "next/link";
import type { OpsAccountSummary } from "@/lib/supabase";

function onboardingLabel(status: OpsAccountSummary["onboardingStatus"]) {
  const labels: Record<OpsAccountSummary["onboardingStatus"], string> = {
    requirements_needed: "Requirements needed",
    waiting_on_customer: "Waiting on customer",
    carrier_review: "Carrier review",
    carrier_attention: "Carrier attention",
    ready_for_live_test: "Ready for live test",
    ready_to_activate: "Ready to activate",
    activated: "Activated",
    paused_incomplete: "Paused incomplete",
    closed_incomplete: "Closed incomplete",
  };

  return labels[status];
}

function billingLabel(status: OpsAccountSummary["billingStatus"]) {
  const labels: Record<OpsAccountSummary["billingStatus"], string> = {
    not_started: "Not started",
    trialing: "Trialing",
    active: "Active",
    past_due: "Past due",
    canceled: "Canceled",
    comped: "Comped",
  };

  return labels[status];
}

function cardTone(account: OpsAccountSummary) {
  if (account.billingStatus === "past_due" || account.onboardingStatus === "carrier_attention") return "ops-account-card--danger";
  if (account.onboardingStatus === "waiting_on_customer" || account.onboardingStatus === "paused_incomplete") return "ops-account-card--warn";
  if (account.onboardingStatus === "activated" && account.billingStatus === "active") return "ops-account-card--good";
  return "";
}

export function OpsAccountDirectory({
  accounts,
  query,
}: {
  accounts: OpsAccountSummary[];
  query: string;
}) {
  return (
    <>
      <form className="lead-controls ops-account-search" action="/ops">
        <input
          className="field"
          name="q"
          defaultValue={query}
          placeholder="Search business or account slug"
          aria-label="Search accounts"
        />
        <button className="btn btn-primary" type="submit">Search accounts</button>
      </form>

      <p className="ops-directory-hint">{"Select an account to manage onboarding and Billing & setup. Technical logs are kept behind Troubleshoot."}</p>

      <div className="ops-account-grid">
        {accounts.length === 0 ? (
          <article className="panel setup-panel ops-account-empty">
            <p className="t-eyebrow">Customer accounts</p>
            <h2>No accounts match this search.</h2>
            <p className="setup-copy">Try a business name or account slug.</p>
          </article>
        ) : accounts.map((account) => (
          <article className={`panel ops-account-card ${cardTone(account)}`} key={account.accountId}>
            <div className="ops-account-card__head">
              <div>
                <p className="t-eyebrow">{account.accountSlug}</p>
                <h2>{account.businessName}</h2>
                <p className="setup-copy">{account.ownerEmail ?? "Owner email not set"}</p>
              </div>
              <span className={`chip ${account.accountStatus === "active" ? "status-pill--booked" : "chip-muted"}`}>
                {account.accountStatus}
              </span>
            </div>

            <div className="ops-account-card__states">
              <div>
                <span className="pulse-sub">Onboarding</span>
                <strong>{onboardingLabel(account.onboardingStatus)}</strong>
              </div>
              <div>
                <span className="pulse-sub">Billing</span>
                <strong>{billingLabel(account.billingStatus)}</strong>
              </div>
              <div>
                <span className="pulse-sub">Subscription</span>
                <strong>{account.stripeSubscriptionStatus ?? "Not connected"}</strong>
              </div>
            </div>

            <div className="ops-account-card__actions">
              <Link className="btn btn-primary btn-sm" href={`/ops?account=${encodeURIComponent(account.accountSlug)}`}>
                Manage account
              </Link>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
