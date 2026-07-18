import Link from "next/link";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { requirePlatformOperator } from "@/lib/auth";
import { listOpsAccounts } from "@/lib/supabase";
import { getOpsLifecycle } from "@/lib/ops-lifecycle";

export const dynamic = "force-dynamic";

function date(value: string | null | undefined) { return value ? new Date(value).toLocaleDateString() : "—"; }

export default async function OpsCustomersPage() {
  await requirePlatformOperator();
  const accounts = await listOpsAccounts();
  const active = accounts.filter((account) => account.billingStatus === "active").length;
  const pilots = accounts.filter((account) => account.billingStatus === "trialing" || account.billingStatus === "comped").length;
  const mrr = accounts.filter((account) => account.billingStatus === "active").length * 99;

  return <main className="leads-view"><section className="leads-shell">
    <OpsHeader currentPage="customers" operatorEmail={null} />
    
    <div className="leads-header"><div><p className="t-eyebrow">Customers</p><h1 className="t-display">Who pays, who pilots, who left.</h1><p className="leads-subtitle">Stripe remains the accounting record. This view keeps the customer story and dates together.</p></div></div>
    <section className="pulse-strip" aria-label="Customer totals"><div className="pulse-cell pulse-cell--brand"><span className="pulse-sub">MRR</span><strong className="pulse-value">${mrr.toLocaleString()}</strong></div><div className="pulse-cell"><span className="pulse-sub">Active</span><strong className="pulse-value">{active}</strong></div><div className="pulse-cell"><span className="pulse-sub">Pilots</span><strong className="pulse-value">{pilots}</strong></div></section>
    <div className="panel setup-panel ops-ledger"><div className="ops-ledger__table-wrap"><table><thead><tr><th>Business</th><th>Stage</th><th>Monthly</th><th>Kickoff</th><th>Started</th><th>Last change</th><th /></tr></thead><tbody>{accounts.map((account) => { const lifecycle = getOpsLifecycle({ onboardingStatus: account.onboardingStatus, billingStatus: account.billingStatus, activatedAt: account.activatedAt, updatedAt: account.updatedAt }); return <tr key={account.accountId}><td><strong>{account.businessName}</strong><small>{account.ownerEmail ?? "Owner not set"}</small></td><td><span className="chip chip-muted">{lifecycle.label}</span></td><td>{account.billingStatus === "active" ? "$99" : account.billingStatus === "comped" ? "Comped" : "—"}</td><td>{account.firstPaidAt ? "Paid" : account.billingStatus === "comped" ? "Waived" : "Pending"}</td><td>{date(account.activatedAt)}</td><td>{date(account.updatedAt)}</td><td><Link className="btn btn-ghost btn-sm" href={`/ops?account=${encodeURIComponent(account.accountSlug)}`}>Open</Link></td></tr>; })}</tbody></table></div></div>
  </section></main>;
}
