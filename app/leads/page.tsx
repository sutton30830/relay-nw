import { LeadsList } from "@/app/leads/leads-list";
import { publicBusinessName } from "@/lib/display-name";
import { requireAccountUser } from "@/lib/auth";
import { DEFAULT_LEADS_PAGE_LIMIT, getForwardingHealthSummary, getLeadInboxPageForAccount } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function readPage(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw ?? "1");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { account, accountId } = await requireAccountUser();
  const businessName = publicBusinessName(account.businessName);
  const params = await searchParams;
  const page = readPage(params.page);
  const offset = (page - 1) * DEFAULT_LEADS_PAGE_LIMIT;

  const [leadPage, forwardingHealth] = await Promise.all([
    getLeadInboxPageForAccount(accountId, { limit: DEFAULT_LEADS_PAGE_LIMIT, offset }),
    getForwardingHealthSummary(accountId),
  ]);

  return (
    <main className="leads-view">
      <LeadsList
        businessName={businessName}
        leads={leadPage.leads}
        forwardingHealth={forwardingHealth}
        pagination={{
          page,
          limit: leadPage.limit,
          offset: leadPage.offset,
          total: leadPage.total,
        }}
      />
    </main>
  );
}
