import { shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";

export type SetupRequestStatus = "new" | "contacted" | "onboarded" | "closed";

export type SetupRequest = {
  id: string;
  name: string | null;
  business_name: string | null;
  owner_name: string | null;
  owner_email: string | null;
  phone: string;
  business_type: string | null;
  public_business_number: string | null;
  message: string | null;
  status: SetupRequestStatus;
  account_id: string | null;
  created_at: string;
};

const SETUP_REQUEST_STATUSES = new Set<SetupRequestStatus>(["new", "contacted", "onboarded", "closed"]);

// Setup requests are prospects for Relay NW itself (from the public intake
// form). They are account-less by design and must never land in any tenant's
// leads inbox.
export async function createSetupRequest(input: {
  name?: string | null;
  businessName: string;
  ownerName: string;
  ownerEmail: string;
  phone: string;
  businessType: string;
  publicBusinessNumber: string;
  message?: string | null;
  submitterHash?: string | null;
}) {
  if (shouldSkipDatabaseWrite("setup request insert", input)) {
    return;
  }

  const { error } = await supabaseAdmin.from("setup_requests").insert({
    name: input.name ?? null,
    business_name: input.businessName,
    owner_name: input.ownerName,
    owner_email: input.ownerEmail.trim().toLowerCase(),
    phone: input.phone,
    business_type: input.businessType,
    public_business_number: input.publicBusinessNumber,
    message: input.message ?? null,
    submitter_hash: input.submitterHash ?? null,
    status: "new",
  });

  throwIfSupabaseError(error);
}

export async function listSetupRequests(status?: SetupRequestStatus | "all") {
  let query = supabaseAdmin
    .from("setup_requests")
    .select("id, name, business_name, owner_name, owner_email, phone, business_type, public_business_number, message, status, account_id, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (status && status !== "all") {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  throwIfSupabaseError(error);

  return (data ?? []) as SetupRequest[];
}

export async function updateSetupRequestStatus(id: string, status: SetupRequestStatus) {
  if (!SETUP_REQUEST_STATUSES.has(status)) {
    throw new Error("Invalid setup request status.");
  }

  const { error } = await supabaseAdmin
    .from("setup_requests")
    .update({ status })
    .eq("id", id);

  throwIfSupabaseError(error);
}

export async function getSetupRequestById(id: string) {
  const { data, error } = await supabaseAdmin
    .from("setup_requests")
    .select("id, name, business_name, owner_name, owner_email, phone, business_type, public_business_number, message, status, account_id, created_at")
    .eq("id", id)
    .maybeSingle();
  throwIfSupabaseError(error);
  return data as SetupRequest | null;
}

export async function markSetupRequestOnboarded(id: string, accountId: string) {
  const { error } = await supabaseAdmin
    .from("setup_requests")
    .update({ status: "onboarded", account_id: accountId })
    .eq("id", id);
  throwIfSupabaseError(error);
}

export async function countRecentSetupRequests(input: {
  submitterHash: string;
  since: string;
}) {
  const { count, error } = await supabaseAdmin
    .from("setup_requests")
    .select("id", { count: "exact", head: true })
    .eq("submitter_hash", input.submitterHash)
    .gte("created_at", input.since);

  throwIfSupabaseError(error);

  return count ?? 0;
}

export async function countSetupRequestsSince(since: string) {
  const { count, error } = await supabaseAdmin
    .from("setup_requests")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since);

  throwIfSupabaseError(error);

  return count ?? 0;
}
