import { OpsHeader } from "@/app/ops/_components/ops-header";
import { requirePlatformOperator } from "@/lib/auth";

export const dynamic = "force-dynamic";

const JOBS = [
  ["Work the queue", "Start in Work queue. Calls, Texting, Billing, and Blocked by are independent; the next action is derived from those facts and never typed by an operator."],
  ["Handle money", "Stripe is the source of truth. Operators send secure setup/card links; only a super admin can confirm a waiver or comp. The $99 trial uses the gated Stripe operation only after automatic text-back is active and nobody remains blocked."],
  ["Find an account", "Use Accounts as the searchable directory, then open the account. Keep diagnostics collapsed until a normal-language state points you there."],
  ["Accept new work", "New requests sit at the top of Onboarding. Accept and invite creates a separate customer tenant with the setup fee due; it never assigns a number or starts monthly billing."],
  ["Manage operators", "Team access is explicit. Super admins can invite, change roles, and revoke. Never revoke yourself, and never remove the last active super admin."],
];

export default async function OpsRunbookPage() {
  await requirePlatformOperator();
  return <main className="leads-view"><section className="leads-shell"><OpsHeader operatorEmail={null} /><div className="leads-header"><div><p className="t-eyebrow">Runbook</p><h1 className="t-display">Run the customer journey.</h1><p className="leads-subtitle">Five jobs, one shared language. Relay Operations is an action inbox. Use the next step on the screen before reaching for diagnostics.</p></div></div><section className="setup-grid">{JOBS.map(([title, summary], index) => <article className="panel setup-panel" key={title}><div className="setup-panel__head"><p className="t-eyebrow">0{index + 1}</p><h2>{title}</h2><p className="setup-copy">{summary}</p></div></article>)}</section></section></main>;
}
