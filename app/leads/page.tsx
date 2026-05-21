import { LeadsList } from "@/app/leads/leads-list";
import { publicBusinessName } from "@/lib/display-name";
import { requireAccountUser } from "@/lib/auth";
import { getForwardingHealthSummary, getLeadsForAccount } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function LeadsPage() {
  const { account, accountId } = await requireAccountUser();
  const businessName = publicBusinessName(account.businessName);

  const [leads, forwardingHealth] = await Promise.all([
    getLeadsForAccount(accountId),
    getForwardingHealthSummary(accountId),
  ]);

  return (
    <main className="leads-view">
      <LeadsList businessName={businessName} leads={leads} forwardingHealth={forwardingHealth} />
    </main>
  );
}
