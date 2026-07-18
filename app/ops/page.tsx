import { OpsAccountDirectory } from "@/app/ops/_components/ops-account-directory";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { OpsToolbar } from "@/app/ops/_components/ops-toolbar";
import { requirePlatformOperator } from "@/lib/auth";
import { getOpsAccountBySlug, getRecentWebhookEventsForAccount, listOpsAccounts } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function billingLabel(status: string) {
  return status === "not_started" ? "Not started" : status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function nextAction(account: Awaited<ReturnType<typeof getOpsAccountBySlug>>) {
  if (!account) return { label: "Choose an account", detail: "Select a customer from the account directory first." };
  if (account.billingStatus === "past_due") return { label: "Resolve payment", detail: "Open the account and use Billing Portal to fix the failed payment." };
  if (account.onboardingStatus === "carrier_attention" || account.onboardingStatus === "carrier_review") return { label: "Monitor carrier approval", detail: "This account is waiting on carrier approval. No customer action is needed." };
  if (account.onboardingStatus === "waiting_on_customer" || account.onboardingStatus === "paused_incomplete" || account.onboardingStatus === "closed_incomplete") {
    return { label: "Follow up with customer", detail: "Open Billing & setup to review or reopen the requirements deadline." };
  }
  if (account.onboardingStatus === "ready_to_activate") return { label: "Review activation", detail: "Confirm the setup fee and start monthly billing when the customer is ready." };
  if (account.billingStatus === "active" || account.billingStatus === "trialing" || account.billingStatus === "comped") {
    return { label: "No action needed", detail: "The account is operating. Use Troubleshoot only when a delivery or webhook issue is reported." };
  }
  return { label: "Finish setup", detail: "Review setup readiness before handing this account to the owner." };
}

function eventMatchesQuery(event: Awaited<ReturnType<typeof getRecentWebhookEventsForAccount>>[number], query: string) {
  if (!query) return true;

  const haystack = [
    event.source,
    event.correlation_id,
    event.error,
    JSON.stringify(event.payload),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; account?: string; view?: string; stage?: "all" | "kickoff" | "setting_up" | "carrier_review" | "ready_to_activate" | "active" | "canceled" }>;
}) {
  const operator = await requirePlatformOperator();
  const { q = "", account: accountSlug = "", view = "overview", stage = "all" } = await searchParams;

  if (!accountSlug) {
    const accounts = await listOpsAccounts(q);

    return (
      <main className="leads-view">
        <section className="leads-shell">
          <OpsHeader operatorEmail={operator.email} />
          <OpsToolbar showSetupRequests subtitle="Move each customer to the next clear step" />

          <div className="leads-header">
            <div>
              <p className="t-eyebrow">Pipeline</p>
              <h1 className="t-display">What needs to move today?</h1>
              <p className="leads-subtitle">
                Every customer has one next step. Open an account only when the card tells you to.
              </p>
            </div>
          </div>

          <OpsAccountDirectory accounts={accounts} query={q} stage={stage} />
        </section>
      </main>
    );
  }

  const account = await getOpsAccountBySlug(accountSlug);
  if (!account) {
    return (
      <main className="leads-view">
        <section className="leads-shell">
          <OpsHeader operatorEmail={operator.email} />
          <OpsToolbar showSetupRequests subtitle="Move each customer to the next clear step" />
          <div className="panel setup-panel ops-account-empty">
            <p className="t-eyebrow">Account not found</p>
            <h1 className="t-display">Choose another account.</h1>
            <p className="setup-copy">The requested account does not exist or is no longer available.</p>
          </div>
        </section>
      </main>
    );
  }

  if (view !== "logs") {
    const action = nextAction(account);

    return (
      <main className="leads-view">
        <section className="leads-shell">
          <OpsHeader businessName={account.businessName} operatorEmail={operator.email} />
          <OpsToolbar showSetupRequests accountSlug={account.accountSlug} subtitle={`Managing ${account.accountSlug}`} />

          <div className="leads-header">
            <div>
              <p className="t-eyebrow">Customer account</p>
              <h1 className="t-display">{account.businessName}</h1>
              <p className="leads-subtitle">One control surface for this account. Start with the next action; use Troubleshoot for raw technical events.</p>
            </div>
          </div>

          <section className="pulse-strip ops-account-overview" aria-label="Account operating summary">
            <div className="pulse-cell pulse-cell--brand">
              <span className="pulse-sub">Account</span>
              <strong className="pulse-value">{account.accountStatus}</strong>
            </div>
            <div className="pulse-cell">
              <span className="pulse-sub">Onboarding</span>
              <strong className="pulse-value">{account.onboardingStatus.replaceAll("_", " ")}</strong>
            </div>
            <div className="pulse-cell">
              <span className="pulse-sub">Billing</span>
              <strong className="pulse-value">{billingLabel(account.billingStatus)}</strong>
            </div>
            <div className="pulse-cell">
              <span className="pulse-sub">Owner</span>
              <strong className="pulse-value">{account.ownerEmail ?? "Not set"}</strong>
            </div>
          </section>

          <section className="ops-next-action panel setup-panel">
            <div>
              <p className="t-eyebrow">Next operator action</p>
              <h2>{action.label}</h2>
              <p className="setup-copy">{action.detail}</p>
            </div>
            <div className="ops-account-overview__actions">
              <a className="btn btn-primary" href={`/ops/billing?account=${encodeURIComponent(account.accountSlug)}`}>Billing &amp; setup</a>
              <a className="btn btn-secondary" href={`/ops?account=${encodeURIComponent(account.accountSlug)}&view=logs`}>Troubleshoot</a>
              <a className="btn btn-secondary" href="/ops/setup-requests">Setup requests</a>
            </div>
          </section>

          <section className="ops-account-facts panel setup-panel">
            <div className="setup-panel__head">
              <p className="t-eyebrow">Account facts</p>
              <h2>Keep the customer context together.</h2>
            </div>
            <dl className="webhook-event__meta">
              <div><dt>Account slug</dt><dd>{account.accountSlug}</dd></div>
              <div><dt>Owner email</dt><dd>{account.ownerEmail ?? "not set"}</dd></div>
              <div><dt>Subscription</dt><dd>{account.stripeSubscriptionStatus ?? "not connected"}</dd></div>
              <div><dt>Requirements due</dt><dd>{account.requirementsDueAt ? new Date(account.requirementsDueAt).toLocaleDateString() : "not set"}</dd></div>
              <div><dt>Activated</dt><dd>{account.activatedAt ? new Date(account.activatedAt).toLocaleDateString() : "not yet"}</dd></div>
              <div><dt>Last account update</dt><dd>{account.updatedAt ? new Date(account.updatedAt).toLocaleString() : "not available"}</dd></div>
            </dl>
          </section>
        </section>
      </main>
    );
  }

  const events = (await getRecentWebhookEventsForAccount(account.accountId, 50))
    .filter((event) => eventMatchesQuery(event, q));

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <OpsHeader businessName={account.businessName} operatorEmail={operator.email} />
        <OpsToolbar showSetupRequests accountSlug={account.accountSlug} view="logs" subtitle={`Troubleshoot · ${account.accountSlug}`} />

        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Troubleshoot</p>
            <h1 className="t-display">{account.businessName}</h1>
            <p className="leads-subtitle">Raw webhook events for {account.accountSlug}. Use this only when the account overview points you here or a delivery state looks off.</p>
          </div>
        </div>

        <form className="lead-controls" action="/ops">
          <input type="hidden" name="account" value={account.accountSlug} />
          <input
            className="field"
            name="q"
            defaultValue={q}
            placeholder="Filter by CallSid, MessageSid, source, status, or last 4"
          />
          <button className="btn btn-primary" type="submit">Filter logs</button>
        </form>

        <div className="webhook-events">
          {events.length === 0 ? (
            <p className="empty-copy">No matching webhook events for this account.</p>
          ) : events.map((event) => (
            <article className="webhook-event" key={event.id}>
              <div className="webhook-event__head">
                <strong>{event.source}</strong>
                <span>{formatDate(event.created_at)}</span>
              </div>
              <dl className="webhook-event__meta">
                <div>
                  <dt>Correlation</dt>
                  <dd>{event.correlation_id ?? "none"}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{event.response_status}</dd>
                </div>
                <div>
                  <dt>Error</dt>
                  <dd>{event.error ?? "none"}</dd>
                </div>
              </dl>
              <pre>{JSON.stringify(event.payload, null, 2)}</pre>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
