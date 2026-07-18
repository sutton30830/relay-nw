import Link from "next/link";
import { Icon } from "@/components/icon";
import { AppHeader } from "@/app/leads/_components/app-header";
import { requireAccountUser } from "@/lib/auth";
import { computeReportHero } from "@/lib/report-hero";
import {
  getAccountRecoveryStats,
  getLeadInboxCountsForAccount,
  type RecoveryStats,
} from "@/lib/supabase";

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

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function ReportMetric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="panel report-metric">
      <p className="t-eyebrow report-metric__label">{label}</p>
      <p className="report-metric__value">{value}</p>
      <p className="report-metric__hint">{hint}</p>
    </div>
  );
}

function ActionCard({
  label,
  value,
  hint,
  href,
  tone = "default",
}: {
  label: string;
  value: string;
  hint: string;
  href: string;
  tone?: "default" | "warning";
}) {
  return (
    <Link className={`panel report-action report-action--${tone}`} href={href}>
      <div>
        <p className="t-eyebrow report-action__label">{label}</p>
        <p className="report-action__value">{value}</p>
        <p className="report-action__hint">{hint}</p>
      </div>
      <span className="report-action__open">
        Open <Icon name="arrowRight" size={13} />
      </span>
    </Link>
  );
}

function CompareItem({ label, current, previous }: { label: string; current: string; previous: string }) {
  return (
    <div className="report-compare__item">
      <p className="t-eyebrow">{label}</p>
      <p>{current}</p>
      <span>Last month: {previous}</span>
    </div>
  );
}

function hasUsefulPriorMonth(stats: RecoveryStats) {
  return stats.missedCalls > 0 || stats.booked > 0 || stats.recoveredCents > 0;
}

export default async function ReportsPage() {
  const { account, accountId, membershipCount } = await requireAccountUser();

  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const [thisMonth, lastMonth, allTime, inboxCounts] = await Promise.all([
    getAccountRecoveryStats(accountId, { since: thisMonthStart.toISOString() }),
    getAccountRecoveryStats(accountId, {
      since: lastMonthStart.toISOString(),
      until: thisMonthStart.toISOString(),
    }),
    getAccountRecoveryStats(accountId, { since: null }),
    getLeadInboxCountsForAccount(accountId),
  ]);

  const hero = computeReportHero({
    booked: thisMonth.booked,
    bookedMissingValue: thisMonth.bookedMissingValue,
    recoveredCents: thisMonth.recoveredCents,
    missedCalls: thisMonth.missedCalls,
    typicalJobValueCents: null,
  });

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <AppHeader
          businessName={account.businessName}
          currentPage="reports"
          switchAccountHref={membershipCount > 1 ? "/account/select?next=/reports" : undefined}
        />

        <div className="report-statement">
          <div className="leads-header">
            <div>
              <p className="t-eyebrow">Reports</p>
              <h1 className="t-display">What Relay recovered</h1>
              <p className="leads-subtitle">{account.businessName}</p>
            </div>
          </div>

          <section
            className={`report-hero report-hero--${hero.scale}`}
            data-contract-copy="booked from Relay leads · Based on job values you entered."
          >
            <p className="t-eyebrow report-hero__label">{monthLabel(now)}</p>
            <div className="report-hero__figure-row">
              <h2 className="report-hero__title">{hero.figure}</h2>
              {hero.estimateLabel ? <span className="report-hero__tag">{hero.estimateLabel}</span> : null}
            </div>
            <p className="report-hero__unit">{hero.unitLine}</p>
            <p className="report-hero__sub">{hero.subLine}</p>
            {hero.footnote ? <p className="report-hero__note">{hero.footnote}</p> : null}
          </section>

          <section className="report-period" aria-label="This month">
            <div className="drawer__section-head report-period__head">
              <p className="t-eyebrow">This month</p>
            </div>
            <div className="report-metric-grid">
              <ReportMetric
                label="Missed calls captured"
                value={String(thisMonth.missedCalls)}
                hint="Calls Relay saved in your inbox."
              />
              <ReportMetric
                label="Leads that replied"
                value={String(thisMonth.uniqueReplyLeads)}
                hint="People who texted back after Relay followed up."
              />
              <ReportMetric
                label="Jobs booked"
                value={String(thisMonth.booked)}
                hint="Leads you marked as booked this month."
              />
              <ReportMetric
                label="Booked value"
                value={formatDollars(thisMonth.recoveredCents)}
                hint="Only counts values you entered."
              />
            </div>
          </section>

          <section className="report-period" aria-label="Needs attention">
            <div className="drawer__section-head report-period__head">
              <p className="t-eyebrow">Needs attention</p>
            </div>
            <div className="report-action-grid">
              <ActionCard
                label="New leads"
                value={String(inboxCounts.new)}
                hint={inboxCounts.new > 0 ? "Call or text these next." : "No fresh leads waiting."}
                href="/leads?filter=new"
              />
              <ActionCard
                label="Failed texts"
                value={String(inboxCounts.smsIssues)}
                hint={
                  inboxCounts.smsIssues > 0
                    ? "Open the inbox and call these directly."
                    : "No known delivery issues."
                }
                href="/leads"
                tone={inboxCounts.smsIssues > 0 ? "warning" : "default"}
              />
              <ActionCard
                label="Booked missing value"
                value={String(thisMonth.bookedMissingValue)}
                hint={
                  thisMonth.bookedMissingValue > 0
                    ? "Add values so reports tell the truth."
                    : "Booked jobs have values entered."
                }
                href="/leads?filter=booked"
              />
            </div>
          </section>

          {hasUsefulPriorMonth(lastMonth) ? (
            <section className="panel report-compare" aria-label="Prior month comparison">
              <div>
                <p className="t-eyebrow">Compared with {monthLabel(lastMonthStart)}</p>
                <h2>Month over month</h2>
              </div>
              <div className="report-compare__grid">
                <CompareItem
                  label="Booked value"
                  current={formatDollars(thisMonth.recoveredCents)}
                  previous={formatDollars(lastMonth.recoveredCents)}
                />
                <CompareItem
                  label="Jobs booked"
                  current={String(thisMonth.booked)}
                  previous={String(lastMonth.booked)}
                />
                <CompareItem
                  label="Missed calls captured"
                  current={String(thisMonth.missedCalls)}
                  previous={String(lastMonth.missedCalls)}
                />
              </div>
            </section>
          ) : null}

          <section className="report-lifetime" aria-label="Lifetime totals">
            <span>All time</span>
            <strong>{formatDollars(allTime.recoveredCents)} booked</strong>
            <span>
              {pluralize(allTime.booked, "job")} · {pluralize(allTime.missedCalls, "missed call")} captured
            </span>
          </section>
        </div>
      </section>
    </main>
  );
}
