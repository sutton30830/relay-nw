import { OpsAccountDirectory } from "@/app/ops/_components/ops-account-directory";
import { OpsHeader } from "@/app/ops/_components/ops-header";
import { requirePlatformOperator } from "@/lib/auth";
import { listOpsAccounts } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function OpsAccountsDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const operator = await requirePlatformOperator();
  const { q = "" } = await searchParams;
  const accounts = await listOpsAccounts();

  return (
    <main className="leads-view">
      <section className="leads-shell">
        <OpsHeader currentPage="accounts" operatorEmail={operator.email} />
        <div className="leads-header">
          <div>
            <p className="t-eyebrow">Accounts</p>
            <h1 className="t-display">Find an account.</h1>
            <p className="leads-subtitle">Use Work queue for priorities. This is just the directory.</p>
          </div>
        </div>
        <OpsAccountDirectory accounts={accounts} query={q} />
      </section>
    </main>
  );
}
