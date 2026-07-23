import { redirect } from "next/navigation";
import { OpsAccountDirectory } from "@/app/ops/_components/ops-account-directory";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { requirePlatformOperator } from "@/lib/auth";
import { listOpsAccounts } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// The pipeline: every customer, grouped by stage, each with one next step.
// Everything about a single customer — money, setup, diagnostics — lives on
// that customer's own page (/ops/accounts/[slug]).
export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    account?: string;
    view?: string;
    stage?: "all" | "setting_up" | "live" | "active" | "paused" | "closed" | "canceled";
  }>;
}) {
  const operator = await requirePlatformOperator();
  const { q = "", account: legacyAccountSlug = "", view, stage = "all" } = await searchParams;

  // Old bookmarks and emails used /ops?account=<slug>[&view=logs]. Send them to
  // the account's own page.
  if (legacyAccountSlug) {
    redirect(
      `/ops/accounts/${encodeURIComponent(legacyAccountSlug)}${view === "logs" ? "#diagnostics" : ""}`,
    );
  }

  const accounts = await listOpsAccounts(q);

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <OpsHeader operatorEmail={operator.email} />

        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Pipeline</p>
            <h1 className="t-display">What needs to move today?</h1>
            <p className="leads-subtitle">
              Every customer has one next step. Open an account only when the card tells you to.
            </p>
          </div>
        </div>

        <OpsAccountDirectory accounts={accounts} query={q} stage={stage} />
      </section>
    </main>
  );
}
