import { redirect } from "next/navigation";
import { OpsAccountDirectory } from "@/app/ops/_components/ops-account-directory";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { requirePlatformOperator } from "@/lib/auth";
import type { OpsQueueGroup } from "@/lib/ops-state";
import { listOpsAccounts } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// One derived work queue: every customer has independent domain facts and one
// next action. No operator selects an overall lifecycle.
// Everything about a single customer — money, setup, diagnostics — lives on
// that customer's own page (/ops/accounts/[slug]).
export default async function OpsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    account?: string;
    view?: string;
    queue?: OpsQueueGroup | "all";
  }>;
}) {
  const operator = await requirePlatformOperator();
  const { q = "", account: legacyAccountSlug = "", view, queue = "all" } = await searchParams;

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
            <p className="t-eyebrow">Operations queue</p>
            <h1 className="t-display">What needs to move today?</h1>
            <p className="leads-subtitle">
              Calls, texting, billing, and blocker ownership stay independent. Relay derives one next action.
            </p>
          </div>
        </div>

        <OpsAccountDirectory accounts={accounts} query={q} queue={queue} />
      </section>
    </main>
  );
}
