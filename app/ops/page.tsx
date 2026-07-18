import { OpsAccountDirectory } from "@/app/ops/_components/ops-account-directory";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { OpsToolbar } from "@/app/ops/_components/ops-toolbar";
import { requirePlatformOperator } from "@/lib/auth";
import { getOpsAccountBySlug, getRecentWebhookEventsForAccount, listOpsAccounts } from "@/lib/supabase";

export const dynamic = "force-dynamic";

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
  searchParams: Promise<{ q?: string; account?: string }>;
}) {
  const operator = await requirePlatformOperator();
  const { q = "", account: accountSlug = "" } = await searchParams;

  if (!accountSlug) {
    const accounts = await listOpsAccounts(q);

    return (
      <main className="leads-view">
        <section className="leads-shell">
          <OpsHeader operatorEmail={operator.email} />
          <OpsToolbar showSetupRequests subtitle="Platform-wide account control" />

          <div className="leads-header">
            <div>
              <p className="t-eyebrow">Relay Operations</p>
              <h1 className="t-display">Customer accounts</h1>
              <p className="leads-subtitle">
                One place to see onboarding, billing, and technical health across every Relay account.
              </p>
            </div>
          </div>

          <OpsAccountDirectory accounts={accounts} query={q} />
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
          <OpsToolbar showSetupRequests subtitle="Platform-wide account control" />
          <div className="panel setup-panel ops-account-empty">
            <p className="t-eyebrow">Account not found</p>
            <h1 className="t-display">Choose another account.</h1>
            <p className="setup-copy">The requested account does not exist or is no longer available.</p>
          </div>
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
        <OpsToolbar showSetupRequests accountSlug={account.accountSlug} subtitle={`Technical logs · ${account.accountSlug}`} />

        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Technical logs</p>
            <h1 className="t-display">{account.businessName}</h1>
            <p className="leads-subtitle">Webhook events for {account.accountSlug}. Use this when the missed-call loop or delivery state looks off.</p>
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
