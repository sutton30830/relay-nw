import { OpsHeader } from "@/app/ops/_components/ops-header";
import { requirePlatformOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

const JOBS = [
  ["Move a customer forward", "Start at Pipeline. Each card has one next step: kickoff, setup, carrier review, ready, or active. The day count is for operator context, not a promise to the customer."],
  ["Handle money", "Collect or waive the $150 kickoff fee, then start $99 billing from the saved card only when setup is ready. Stripe is the source of truth; refunds are real and daily reconciliation repairs missed events."],
  ["Track the customer", "Use Customers for the commercial ledger and open an account from any card. Keep diagnostics collapsed until a normal-language state points you there."],
  ["Manage requests", "Requests are prospects, not leads. Accept and invite creates a separate customer tenant with the setup fee due; it never assigns a number or starts monthly billing."],
  ["Manage operators", "Team access is explicit. Super admins can invite, change roles, and revoke. Never revoke yourself, and never remove the last active super admin."],
];

export default async function OpsRunbookPage() {
  await requirePlatformOperator();
  return <main className="leads-view"><section className="leads-shell"><OpsHeader operatorEmail={null} /><div className="leads-header"><div><p className="t-eyebrow">Runbook</p><h1 className="t-display">Run the customer journey.</h1><p className="leads-subtitle">Five jobs, one shared language. Relay Operations is an action inbox. Use the next step on the screen before reaching for diagnostics.</p></div></div><section className="setup-grid">{JOBS.map(([title, summary], index) => <article className="panel setup-panel" key={title}><div className="setup-panel__head"><p className="t-eyebrow">0{index + 1}</p><h2>{title}</h2><p className="setup-copy">{summary}</p></div></article>)}</section></section></main>;
}
