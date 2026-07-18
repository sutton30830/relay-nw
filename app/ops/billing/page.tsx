import { AppHeader } from "@/app/leads/_components/app-header";
import { OpsToolbar } from "@/app/ops/_components/ops-toolbar";
import { isRelayOperator, requireAccountUser } from "@/lib/auth";
import { daysUntil } from "@/lib/onboarding-deadlines";
import {
  canMoveAccountToCustomerDelay,
  getAccountBillingRecord,
  getRecentStripeEventsForAccount,
  listAccountsForOnboardingDeadlineMaintenance,
  type OnboardingDeadlineAccount,
} from "@/lib/supabase";

export const dynamic = "force-dynamic";

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function eventMatchesQuery(event: Awaited<ReturnType<typeof getRecentStripeEventsForAccount>>[number], query: string) {
  if (!query) return true;

  const haystack = [
    event.event_id,
    event.event_type,
    event.processing_status,
    event.error_code,
    event.ignore_reason,
    event.stripe_customer_id,
    event.stripe_subscription_id,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}

function statusTone(status: string) {
  if (status === "processed") return "good";
  if (status === "failed") return "bad";
  if (status === "ignored") return "warn";
  return "neutral";
}

function onboardingStatusCopy(status: string) {
  if (status === "requirements_needed") return "Requirements needed";
  if (status === "waiting_on_customer") return "Waiting on customer";
  if (status === "carrier_review") return "Waiting on carrier/A2P";
  if (status === "carrier_attention") return "Carrier/A2P needs attention";
  if (status === "ready_for_live_test") return "Ready for live test";
  if (status === "ready_to_activate") return "Ready to activate";
  if (status === "activated") return "Activated";
  if (status === "paused_incomplete") return "Paused incomplete";
  if (status === "closed_incomplete") return "Closed incomplete";
  return status.replaceAll("_", " ");
}

function onboardingNotice(status: string | undefined, accountSlug: string | undefined) {
  if (!status) return null;

  const prefix = accountSlug ? `${accountSlug}: ` : "";
  if (status === "requested") return `${prefix}customer requirements deadline started.`;
  if (status === "reopened") return `${prefix}customer requirements deadline reopened with a new 14-day due date.`;
  if (status === "not_customer_delay") return `${prefix}not changed. This account is not in a customer-delay state.`;
  if (status === "account_not_found") return `${prefix}account not found.`;
  if (status === "missing_account") return "Enter an account slug.";
  if (status === "save_failed") return `${prefix}deadline update failed. Check logs before trying again.`;
  return null;
}

function OnboardingDeadlineCard({ account }: { account: OnboardingDeadlineAccount }) {
  const days = account.requirementsDueAt ? daysUntil(account.requirementsDueAt) : null;
  const dueCopy = days === null
    ? "No due date"
    : days > 0
      ? `Due in ${days} day${days === 1 ? "" : "s"}`
      : days === 0
        ? "Due today"
        : `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`;

  return (
    <article className="webhook-event">
      <div className="webhook-event__head">
        <div>
          <strong>{account.businessName}</strong>
          <p className="empty-copy">{account.accountSlug}</p>
        </div>
        <span className={account.onboardingStatus === "paused_incomplete" ? "chip chip-danger" : "chip chip-muted"}>
          {onboardingStatusCopy(account.onboardingStatus)}
        </span>
      </div>
      <dl className="webhook-event__meta">
        <div>
          <dt>Requirements</dt>
          <dd>{dueCopy}</dd>
        </div>
        <div>
          <dt>Due date</dt>
          <dd>{formatDate(account.requirementsDueAt)}</dd>
        </div>
        <div>
          <dt>Owner email</dt>
          <dd>{account.ownerEmail ?? "not set"}</dd>
        </div>
      </dl>
    </article>
  );
}

export default async function OpsBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; onboarding?: string; account?: string }>;
}) {
  const session = await requireAccountUser();
  const { account, accountId } = session;
  const { q = "", onboarding, account: onboardingAccountSlug } = await searchParams;
  const showSetupRequests = isRelayOperator(session);
  const [billing, allEvents, onboardingDeadlines] = await Promise.all([
    getAccountBillingRecord(accountId),
    getRecentStripeEventsForAccount(accountId, 50),
    showSetupRequests ? listAccountsForOnboardingDeadlineMaintenance() : Promise.resolve([]),
  ]);
  const events = allEvents.filter((event) => eventMatchesQuery(event, q));
  const failedCount = allEvents.filter((event) => event.processing_status === "failed").length;
  const ignoredCount = allEvents.filter((event) => event.processing_status === "ignored").length;
  const processingCount = allEvents.filter((event) => event.processing_status === "processing").length;
  const notice = onboardingNotice(onboarding, onboardingAccountSlug);
  const canStartCustomerDelay = canMoveAccountToCustomerDelay(billing.onboardingStatus, billing);

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <AppHeader
          businessName={account.businessName}
          switchAccountHref={session.membershipCount > 1 ? "/account/select?next=/ops/billing" : undefined}
        />

        <OpsToolbar showSetupRequests={showSetupRequests} subtitle="Billing diagnostics" />

        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Ops</p>
            <h1 className="t-display">Billing events</h1>
            <p className="leads-subtitle">
              Stripe webhook processing for {account.businessName}. Use this when Checkout, Portal, payment, or subscription state looks off.
            </p>
          </div>
        </div>

        <section className="pulse-strip ops-billing-summary" aria-label="Billing status summary">
          <div className="pulse-cell pulse-cell--brand">
            <span className="pulse-sub">Billing</span>
            <strong className="pulse-value">{billing.billingStatus}</strong>
          </div>
          <div className="pulse-cell">
            <span className="pulse-sub">Subscription</span>
            <strong className="pulse-value">{billing.stripeSubscriptionStatus ?? "none"}</strong>
          </div>
          <div className="pulse-cell">
            <span className="pulse-sub">Failed events</span>
            <strong className="pulse-value">{failedCount}</strong>
          </div>
          <div className="pulse-cell">
            <span className="pulse-sub">Ignored / processing</span>
            <strong className="pulse-value">{ignoredCount} / {processingCount}</strong>
          </div>
        </section>

        <article className="panel setup-panel ops-billing-card">
          <div className="setup-panel__head">
            <p className="t-eyebrow">Current account billing record</p>
            <h2>{account.businessName}</h2>
            <p className="setup-copy">
              This is Relay&apos;s current account state after webhook processing. Stripe remains the source of truth for subscription status.
            </p>
          </div>
          <dl className="webhook-event__meta ops-billing-meta">
            <div>
              <dt>Customer</dt>
              <dd>{billing.stripeCustomerId ?? "none"}</dd>
            </div>
            <div>
              <dt>Subscription</dt>
              <dd>{billing.stripeSubscriptionId ?? "none"}</dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd>{billing.stripePriceId ?? "none"}</dd>
            </div>
            <div>
              <dt>Current period end</dt>
              <dd>{formatDate(billing.currentPeriodEnd)}</dd>
            </div>
            <div>
              <dt>Cancel at period end</dt>
              <dd>{billing.cancelAtPeriodEnd ? "yes" : "no"}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{formatDate(billing.billingUpdatedAt)}</dd>
            </div>
          </dl>
        </article>

        {showSetupRequests ? (
          <article className="panel setup-panel ops-billing-card">
            <div className="setup-panel__head">
              <p className="t-eyebrow">Assisted onboarding deadlines</p>
              <h2>Customer-delay queue</h2>
              <p className="setup-copy">
                Accounts waiting on customer requirements. Carrier review accounts are intentionally excluded from this clock.
              </p>
            </div>
            {notice ? (
              <div className={onboarding === "requested" || onboarding === "reopened" ? "settings-notice" : "intake-error settings-notice"} role="status">
                {notice}
              </div>
            ) : null}
            <form action="/api/ops/onboarding-deadlines" method="post" className="setup-panel__action">
              <label className="field-label" htmlFor="customer-delay-account">
                Account slug waiting on customer
              </label>
              <div className="lead-controls" style={{ margin: 0 }}>
                <input
                  id="customer-delay-account"
                  className="field"
                  name="account_slug"
                  defaultValue={account.accountSlug}
                  placeholder="relay-nw"
                />
                <button className="btn btn-primary" type="submit">
                  Start / reopen 14-day clock
                </button>
              </div>
              <p className="setup-panel__note">
                Use only when Relay is waiting on the customer for business requirements. Do not use this for carrier/A2P review.
                Current selected account: {onboardingStatusCopy(billing.onboardingStatus)}
                {canStartCustomerDelay ? "." : " — not eligible for the customer-delay clock."}
              </p>
            </form>
            <div className="webhook-events">
              {onboardingDeadlines.length === 0 ? (
                <p className="empty-copy">No accounts are waiting on customer requirements.</p>
              ) : (
                onboardingDeadlines.map((deadline) => (
                  <OnboardingDeadlineCard key={deadline.accountId} account={deadline} />
                ))
              )}
            </div>
          </article>
        ) : null}

        <form className="lead-controls" action="/ops/billing">
          <input
            className="field"
            name="q"
            defaultValue={q}
            placeholder="Filter by event id, type, customer, subscription, status, or reason"
          />
          <button className="btn btn-primary" type="submit">Filter</button>
        </form>

        <div className="webhook-events">
          {events.length === 0 ? (
            <p className="empty-copy">No matching Stripe billing events.</p>
          ) : events.map((event) => (
            <article className="webhook-event" key={event.event_id}>
              <div className="webhook-event__head">
                <strong>{event.event_type}</strong>
                <span className={`ops-billing-status ops-billing-status--${statusTone(event.processing_status)}`}>
                  {event.processing_status}
                </span>
              </div>
              <dl className="webhook-event__meta">
                <div>
                  <dt>Event</dt>
                  <dd>{event.event_id}</dd>
                </div>
                <div>
                  <dt>Received</dt>
                  <dd>{formatDate(event.received_at)}</dd>
                </div>
                <div>
                  <dt>Stripe created</dt>
                  <dd>{formatDate(event.event_created_at)}</dd>
                </div>
                <div>
                  <dt>Mode</dt>
                  <dd>{event.livemode ? "live" : "test"}</dd>
                </div>
                <div>
                  <dt>Attempts</dt>
                  <dd>{event.attempt_count}</dd>
                </div>
                <div>
                  <dt>Processed</dt>
                  <dd>{formatDate(event.processed_at)}</dd>
                </div>
                <div>
                  <dt>Customer</dt>
                  <dd>{event.stripe_customer_id ?? "none"}</dd>
                </div>
                <div>
                  <dt>Subscription</dt>
                  <dd>{event.stripe_subscription_id ?? "none"}</dd>
                </div>
                <div>
                  <dt>Reason / error</dt>
                  <dd>{event.error_code ?? event.ignore_reason ?? "none"}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
