import Link from "next/link";
import { Icon } from "@/components/icon";
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
    <div className="panel" style={{ padding: "16px 18px" }}>
      <p className="t-eyebrow" style={{ margin: 0 }}>{label}</p>
      <p style={{ fontSize: 28, fontWeight: 700, margin: "6px 0 0", color: "var(--ink)" }}>{value}</p>
      {hint ? <p style={{ color: "var(--ink-4)", fontSize: 12.5, margin: "4px 0 0" }}>{hint}</p> : null}
    </div>
  );
}

function PeriodSection({ title, stats }: { title: string; stats: RecoveryStats }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div className="drawer__section-head" style={{ marginBottom: 12 }}>
        <p className="t-eyebrow">{title}</p>
      </div>
      <div
        style={{
          display: "grid",
          gap: 12,
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        }}
      >
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
        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Reports</p>
            <h1 className="t-display">Recovered revenue</h1>
            <p className="leads-subtitle">{account.businessName}</p>
          </div>
          <div className="lead-actions">
            <Link className="btn btn-secondary" href="/leads">
              <Icon name="message" size={14} /> Back to leads
            </Link>
          </div>
        </div>

        <section
          className="panel"
          style={{ marginBottom: 28, padding: "24px 22px", textAlign: "center" }}
        >
          <p className="t-eyebrow" style={{ margin: 0 }}>
            Recovered so far in {monthLabel(now)}
          </p>
          <p style={{ fontSize: 44, fontWeight: 800, margin: "8px 0 4px" }}>
            {formatDollars(heroCents)}
          </p>
          <p style={{ color: "var(--ink-4)", margin: 0, fontSize: 14 }}>
            from {thisMonth.booked} booked {thisMonth.booked === 1 ? "job" : "jobs"} out of{" "}
            {thisMonth.missedCalls} missed {thisMonth.missedCalls === 1 ? "call" : "calls"} caught
          </p>
        </section>

        <PeriodSection title={monthLabel(now)} stats={thisMonth} />
        <PeriodSection title={monthLabel(lastMonthStart)} stats={lastMonth} />
        <PeriodSection title="All time" stats={allTime} />

        <p style={{ color: "var(--ink-4)", fontSize: 12.5 }}>
          Recovered revenue counts the booked value you enter on leads, attributed to the
          month the job was booked.
        </p>
      </section>
    </main>
  );
}
