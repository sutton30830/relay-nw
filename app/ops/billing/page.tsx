import { AppHeader } from "@/app/leads/_components/app-header";
import { OpsToolbar } from "@/app/ops/_components/ops-toolbar";
import { isRelayOperator, requireAccountUser } from "@/lib/auth";
import { getAccountBillingRecord, getRecentStripeEventsForAccount } from "@/lib/supabase";

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

export default async function OpsBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireAccountUser();
  const { account, accountId } = session;
  const { q = "" } = await searchParams;
  const showSetupRequests = isRelayOperator(session);
  const [billing, allEvents] = await Promise.all([
    getAccountBillingRecord(accountId),
    getRecentStripeEventsForAccount(accountId, 50),
  ]);
  const events = allEvents.filter((event) => eventMatchesQuery(event, q));
  const failedCount = allEvents.filter((event) => event.processing_status === "failed").length;
  const ignoredCount = allEvents.filter((event) => event.processing_status === "ignored").length;
  const processingCount = allEvents.filter((event) => event.processing_status === "processing").length;

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
