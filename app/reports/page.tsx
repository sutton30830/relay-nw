import Link from "next/link";
import { Icon } from "@/components/icon";
import { AppHeader } from "@/app/leads/_components/app-header";
import { requireAccountUser } from "@/lib/auth";
import {
  getAccountRecoveryStats,
  getAccountResponseStats,
  getLeadInboxCountsForAccount,
  type RecoveryStats,
} from "@/lib/supabase";
import { formatPercent, formatResponseTime, rate } from "@/lib/report-metrics";

export const dynamic = "force-dynamic";

function formatDollars(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function monthLabel(date: Date) {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel report-tile">
      <p className="t-eyebrow report-tile__label">{label}</p>
      <p className="report-tile__value">{value}</p>
      {hint ? <p className="report-tile__hint">{hint}</p> : null}
    </div>
  );
}

// A headline metric. When href is set it's a clickable path into the relevant
// filtered inbox, so a number turns into the next action.
function MetricTile({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
}) {
  const body = (
    <>
      <p className="t-eyebrow report-tile__label">{label}</p>
      <p className="report-tile__value">{value}</p>
      {hint ? <p className="report-tile__hint">{hint}</p> : null}
      {href ? (
        <span className="report-tile__link">
          Open <Icon name="arrowRight" size={12} />
        </span>
      ) : null}
    </>
  );
  return href ? (
    <Link className="panel report-tile report-tile--link" href={href}>
      {body}
    </Link>
  ) : (
    <div className="panel report-tile">{body}</div>
  );
}

function PeriodSection({ title, stats }: { title: string; stats: RecoveryStats }) {
  return (
    <section className="report-period">
      <div className="drawer__section-head report-period__head">
        <p className="t-eyebrow">{title}</p>
      </div>
      <div className="report-tile-grid">
        <StatTile label="Missed calls caught" value={String(stats.missedCalls)} />
        <StatTile label="Texted back" value={String(stats.textedBack)} />
        <StatTile label="Urgent calls" value={String(stats.urgent)} />
        <StatTile label="Customer replies" value={String(stats.replies)} />
        <StatTile
          label="Jobs booked"
          value={String(stats.booked)}
          hint={stats.booked === 0 ? "Mark leads booked with a value" : undefined}
        />
        <StatTile label="Recovered" value={formatDollars(stats.recoveredCents)} />
      </div>
    </section>
  );
}

export default async function ReportsPage() {
  const { account, accountId, membershipCount } = await requireAccountUser();

  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [thisMonth, lastMonth, allTime, responseThisMonth, inboxCounts] = await Promise.all([
    getAccountRecoveryStats(accountId, { since: thisMonthStart.toISOString() }),
    getAccountRecoveryStats(accountId, {
      since: lastMonthStart.toISOString(),
      until: thisMonthStart.toISOString(),
    }),
    getAccountRecoveryStats(accountId, { since: null }),
    getAccountResponseStats(accountId, { since: thisMonthStart.toISOString() }),
    getLeadInboxCountsForAccount(accountId),
  ]);

  const heroCents = thisMonth.recoveredCents;

  // Action-oriented headline metrics for this month.
  const bookingRate = rate(thisMonth.booked, thisMonth.missedCalls);
  const textAttempts = thisMonth.textedBack + thisMonth.smsFailed;
  const textSuccessRate = rate(thisMonth.textedBack, textAttempts);
  const awaitingAction = inboxCounts.new;

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <AppHeader
          businessName={account.businessName}
          currentPage="reports"
          switchAccountHref={membershipCount > 1 ? "/account/select?next=/reports" : undefined}
        />

        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Reports</p>
            <h1 className="t-display">Recovered revenue</h1>
            <p className="leads-subtitle">{account.businessName}</p>
          </div>
        </div>

        <section className="panel report-hero">
          <p className="t-eyebrow report-hero__label">
            Recovered so far in {monthLabel(now)}
          </p>
          <p className="report-hero__value">
            {formatDollars(heroCents)}
          </p>
          <p className="report-hero__sub">
            from {thisMonth.booked} booked {thisMonth.booked === 1 ? "job" : "jobs"} out of{" "}
            {thisMonth.missedCalls} missed {thisMonth.missedCalls === 1 ? "call" : "calls"} caught
          </p>
        </section>

        <section className="report-period" aria-label="This month at a glance">
          <div className="drawer__section-head report-period__head">
            <p className="t-eyebrow">This month at a glance</p>
          </div>
          <div className="report-tile-grid">
            <MetricTile
              label="Booking rate"
              value={formatPercent(bookingRate)}
              hint={`${thisMonth.booked} of ${thisMonth.missedCalls} caught`}
            />
            <MetricTile
              label="Median response"
              value={formatResponseTime(responseThisMonth.medianSeconds)}
              hint={
                responseThisMonth.sampleSize > 0
                  ? "Missed call to first text back"
                  : "No responses yet this month"
              }
            />
            <MetricTile
              label="Leads awaiting action"
              value={String(awaitingAction)}
              hint={awaitingAction > 0 ? "New leads to work now" : "You're all caught up"}
              href={awaitingAction > 0 ? "/leads?filter=new" : undefined}
            />
            <MetricTile
              label="Text success rate"
              value={formatPercent(textSuccessRate)}
              hint={
                textAttempts > 0
                  ? `${thisMonth.textedBack} of ${textAttempts} delivered`
                  : "No auto-texts sent yet"
              }
            />
          </div>
        </section>

        <PeriodSection title={monthLabel(now)} stats={thisMonth} />
        <PeriodSection title={monthLabel(lastMonthStart)} stats={lastMonth} />
        <PeriodSection title="All time" stats={allTime} />

        <p className="report-note">
          Recovered revenue counts the booked value you enter on leads, attributed to the
          month the job was booked.
        </p>
      </section>
    </main>
  );
}
