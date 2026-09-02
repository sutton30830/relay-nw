import { LeadsList } from "@/app/leads/leads-list";
import { publicBusinessName } from "@/lib/display-name";
import { isRelayOperator, requireAccountUser } from "@/lib/auth";
import { loadOwnerServiceStatus } from "@/lib/onboarding-readiness";
import {
  DEFAULT_LEADS_PAGE_LIMIT,
  getLeadInboxCountsForAccount,
  getLeadInboxPageForAccount,
  type LeadInboxFilter,
} from "@/lib/supabase";

export const dynamic = "force-dynamic";

const VALID_FILTERS: LeadInboxFilter[] = ["all", "new", "contacted", "booked", "dead", "trash"];

function readPage(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw ?? "1");
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
}

function readFilter(value: string | string[] | undefined): LeadInboxFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  return (VALID_FILTERS as string[]).includes(raw ?? "") ? (raw as LeadInboxFilter) : "all";
}

function readQuery(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw ?? "").trim();
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string | string[]; filter?: string | string[]; q?: string | string[] }>;
}) {
  const session = await requireAccountUser();
  const { account, accountId, membershipCount } = session;
  const businessName = publicBusinessName(account.businessName);
  const params = await searchParams;
  const page = readPage(params.page);
  const filter = readFilter(params.filter);
  const query = readQuery(params.q);
  const offset = (page - 1) * DEFAULT_LEADS_PAGE_LIMIT;

  // Counts span the whole account (every filter pill), so they're a separate
  // query from the current filtered/searched page of rows.
  const [leadPage, counts, serviceStatus] = await Promise.all([
    getLeadInboxPageForAccount(accountId, {
      limit: DEFAULT_LEADS_PAGE_LIMIT,
      offset,
      filter,
      query,
    }),
    getLeadInboxCountsForAccount(accountId),
    loadOwnerServiceStatus(accountId, account),
  ]);

  return (
    <main className="leads-view">
      <LeadsList
        businessName={businessName}
        switchAccountHref={membershipCount > 1 ? "/account/select?next=/leads" : undefined}
        showOperations={isRelayOperator(session)}
        leads={leadPage.leads}
        counts={counts}
        serviceStatus={serviceStatus}
        callCounts={leadPage.callCounts ?? {}}
        pagination={{
          page,
          limit: leadPage.limit,
          offset: leadPage.offset,
          total: leadPage.total,
          filter,
          query,
        }}
      />
    </main>
  );
}
