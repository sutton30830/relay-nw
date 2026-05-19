import { cookies } from "next/headers";
import Link from "next/link";
import { getDefaultAccountConfig, getRecentWebhookEventsForAccount } from "@/lib/supabase";
import { isValidLeadsSessionCookie, LEADS_COOKIE_NAME } from "@/lib/leads-auth";

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

export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const cookieStore = await cookies();
  const isAllowed = isValidLeadsSessionCookie(cookieStore.get(LEADS_COOKIE_NAME)?.value);

  if (!isAllowed) {
    return (
      <main className="gate-view">
        <section className="gate-card">
          <p className="t-eyebrow">Relay NW · Protected</p>
          <h1 className="t-display gate-title">Ops debug</h1>
          <p className="gate-sub">Open the lead inbox first, then return to ops.</p>
          <Link className="btn btn-primary" href="/leads">Open leads</Link>
        </section>
      </main>
    );
  }

  const account = await getDefaultAccountConfig();
  const { q = "" } = await searchParams;
  const events = (await getRecentWebhookEventsForAccount(account.accountId, 50))
    .filter((event) => eventMatchesQuery(event, q));

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Ops</p>
            <h1 className="t-display">Webhook debug</h1>
            <p className="leads-subtitle">{account.businessName}</p>
          </div>
          <Link className="btn btn-secondary" href="/leads">Back to leads</Link>
        </div>

        <form className="lead-controls" action="/ops">
          <input
            className="field"
            name="q"
            defaultValue={q}
            placeholder="Filter by CallSid, MessageSid, source, status, or last 4"
          />
          <button className="btn btn-primary" type="submit">Filter</button>
        </form>

        <div className="webhook-events">
          {events.length === 0 ? (
            <p className="empty-copy">No matching webhook events.</p>
          ) : events.map((event) => (
            <article className="webhook-event" key={event.id}>
              <div className="webhook-event__head">
                <strong>{event.source}</strong>
                <span>{new Date(event.created_at).toLocaleString()}</span>
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
