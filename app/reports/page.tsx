import { AppHeader } from "@/app/leads/_components/app-header";
import { requireAccountUser } from "@/lib/auth";
import { getAccountRecoveryStats, type RecoveryStats } from "@/lib/supabase";

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

function PeriodSection({ title, stats }: { title: string; stats: RecoveryStats }) {
  return (
    <section className="report-period">
      <div className="drawer__section-head report-period__head">
        <p className="t-eyebrow">{title}</p>
      </div>
      <div className="report-tile-grid">
        <StatTile label="Missed calls caught" value={String(stats.missedCalls)} />
        <StatTile label="Texted back" value={String(stats.textedBack)} />
        <StatTile label="ASAP callbacks" value={String(stats.urgent)} />
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
  const { account, accountId } = await requireAccountUser();

  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [thisMonth, lastMonth, allTime] = await Promise.all([
    getAccountRecoveryStats(accountId, { since: thisMonthStart.toISOString() }),
    getAccountRecoveryStats(accountId, {
      since: lastMonthStart.toISOString(),
      until: thisMonthStart.toISOString(),
    }),
    getAccountRecoveryStats(accountId, { since: null }),
  ]);

  const heroCents = thisMonth.recoveredCents;

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <AppHeader businessName={account.businessName} currentPage="reports" />

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
