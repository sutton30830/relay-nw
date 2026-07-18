import Link from "next/link";
import { Icon } from "@/components/icon";
import { AppHeader } from "@/app/leads/_components/app-header";
import { isRelayOperator, requireAccountUser } from "@/lib/auth";
import { computeReportHero } from "@/lib/report-hero";
import { getLeadInboxCountsForAccount } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function formatDollars(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function bookedValueLabel(bookedCount: number, bookedValueCents: number) {
  if (bookedCount <= 0) return null;
  if (bookedValueCents <= 0) return "No values entered yet";
  return formatDollars(bookedValueCents);
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

export default async function ReportsPage() {
  const session = await requireAccountUser();
  const { account, accountId, membershipCount } = session;

  const inboxCounts = await getLeadInboxCountsForAccount(accountId);
  const bookedMissingValue = Math.max(0, inboxCounts.booked - inboxCounts.bookedWithValue);
  const bookedValue = bookedValueLabel(inboxCounts.booked, inboxCounts.bookedValueCents);

  const hero = computeReportHero({
    booked: inboxCounts.booked,
    bookedMissingValue,
    recoveredCents: inboxCounts.bookedValueCents,
    missedCalls: inboxCounts.all,
    typicalJobValueCents: account.typicalJobValueCents,
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
      count: bookedMissingValue,
      hint:
        bookedMissingValue > 0
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
          showOperations={isRelayOperator(session)}
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
            data-contract-copy="live inbox snapshot · Based on job values you entered."
          >
            <p className="t-eyebrow report-hero__label">Live inbox</p>
            <div className="report-hero__figure-row">
              <h2 className="report-hero__title">{hero.figure}</h2>
              {hero.estimateLabel ? <span className="report-hero__tag">{hero.estimateLabel}</span> : null}
            </div>
            <p className="report-hero__unit">{hero.unitLine}</p>
            <p className="report-hero__sub">{hero.subLine}</p>
            {hero.footnote ? <p className="report-hero__note">{hero.footnote}</p> : null}
          </section>

          <section className="report-period" aria-label="Live inbox">
            <div className="drawer__section-head report-period__head">
              <p className="t-eyebrow">Current inbox</p>
            </div>
            <div className="ledger">
              <LedgerRow
                label="Leads in inbox"
                value={String(inboxCounts.all)}
                hint="Current non-trash lead cards in your inbox."
              />
              <LedgerRow
                label="New leads"
                value={String(inboxCounts.new)}
                hint="Leads waiting for your next action."
              />
              <LedgerRow
                label="Jobs booked"
                value={String(inboxCounts.booked)}
                hint="Leads currently marked as booked."
              />
              <LedgerRow
                label="Booked value"
                value={bookedValue ?? "Add booked jobs first"}
                hint={
                  bookedValue
                    ? "Only counts values currently entered on booked leads."
                    : "Mark a lead as booked, then add the job value."
                }
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
            <div className="report-footer__lifetime" aria-label="Lifetime totals">
              <span>Current mailbox</span>
              {bookedValue ? <strong>{bookedValue} booked</strong> : <strong>No booked value entered</strong>}
              <span>
                {pluralize(inboxCounts.booked, "job")} · {pluralize(inboxCounts.all, "lead")} in inbox
              </span>
            </div>
          </footer>
        </div>
      </section>
    </main>
  );
}
