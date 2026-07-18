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

function LedgerRow({
  label,
  value,
  hint,
  emphasis = false,
}: {
  label: string;
  value: string;
  hint: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`ledger__row${emphasis ? " ledger__row--total" : ""}`}>
      <div>
        <p className="t-eyebrow ledger__label">{label}</p>
        <p className="ledger__hint">{hint}</p>
      </div>
      <p className="ledger__value">{value}</p>
    </div>
  );
}

function AttentionRow({
  label,
  count,
  hint,
  href,
  tone = "default",
}: {
  label: string;
  count: number;
  hint: string;
  href: string;
  tone?: "default" | "warning";
}) {
  return (
    <Link className={`attention__row attention__row--${tone}`} href={href}>
      <span className="attention__count">{count}</span>
      <div className="attention__body">
        <p className="attention__label">{label}</p>
        <p className="attention__hint">{hint}</p>
      </div>
      <span className="attention__open">
        Open <Icon name="arrowRight" size={13} />
      </span>
    </Link>
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
  const attentionItems: Array<{
    label: string;
    count: number;
    hint: string;
    href: string;
    tone?: "default" | "warning";
  }> = [
    {
      label: "New leads",
      count: inboxCounts.new,
      hint: inboxCounts.new > 0 ? "Call or text these next." : "No fresh leads waiting.",
      href: "/leads?filter=new",
    },
    {
      label: "Failed texts",
      count: inboxCounts.smsIssues,
      hint: inboxCounts.smsIssues > 0 ? "Open the inbox and call these directly." : "No known delivery issues.",
      href: "/leads",
      tone: "warning",
    },
    {
      label: "Booked missing value",
      count: thisMonth.bookedMissingValue,
      hint:
        thisMonth.bookedMissingValue > 0
          ? "Add values so reports tell the truth."
          : "Booked jobs have values entered.",
      href: "/leads?filter=booked",
    },
  ];
  const activeAttentionItems = attentionItems.filter((item) => item.count > 0);

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
            <div className="ledger">
              <LedgerRow
                label="Missed calls captured"
                value={String(thisMonth.missedCalls)}
                hint="Calls Relay saved in your inbox."
              />
              <LedgerRow
                label="Leads that replied"
                value={String(thisMonth.uniqueReplyLeads)}
                hint="People who texted back after Relay followed up."
              />
              <LedgerRow
                label="Jobs booked"
                value={String(thisMonth.booked)}
                hint="Leads you marked as booked this month."
              />
              <LedgerRow
                label="Booked value"
                value={formatDollars(thisMonth.recoveredCents)}
                hint="Only counts values you entered."
                emphasis
              />
            </div>
          </section>

          <section className="report-period" aria-label="Needs attention">
            <div className="drawer__section-head report-period__head">
              <p className="t-eyebrow">Needs attention</p>
            </div>
            {activeAttentionItems.length > 0 ? (
              <div className="attention">
                {activeAttentionItems.map((item) => (
                  <AttentionRow
                    key={item.label}
                    label={item.label}
                    count={item.count}
                    hint={item.hint}
                    href={item.href}
                    tone={item.tone}
                  />
                ))}
              </div>
            ) : (
              <div className="attention__clear">
                <Icon name="check" size={14} />
                <span>Nothing needs your attention.</span>
              </div>
            )}
          </section>

          <footer className="report-footer" aria-label="Statement totals">
            {hasUsefulPriorMonth(lastMonth) ? (
              <div className="report-footer__compare" aria-label={`Compared with ${monthLabel(lastMonthStart)}`}>
                <span>
                  {formatDollars(thisMonth.recoveredCents)} booked
                  <small>{monthLabel(lastMonthStart)}: {formatDollars(lastMonth.recoveredCents)}</small>
                </span>
                <span>
                  {pluralize(thisMonth.booked, "job")}
                  <small>{monthLabel(lastMonthStart)}: {lastMonth.booked}</small>
                </span>
                <span>
                  {pluralize(thisMonth.missedCalls, "missed call")} captured
                  <small>{monthLabel(lastMonthStart)}: {lastMonth.missedCalls}</small>
                </span>
              </div>
            ) : null}
            <div className="report-footer__lifetime" aria-label="Lifetime totals">
              <span>All time</span>
              <strong>{formatDollars(allTime.recoveredCents)} booked</strong>
              <span>
                {pluralize(allTime.booked, "job")} · {pluralize(allTime.missedCalls, "missed call")} captured
              </span>
            </div>
          </footer>
        </div>
      </section>
    </main>
  );
}
