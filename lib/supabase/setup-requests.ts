import { shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";

// Setup requests are prospects for Relay NW itself (from the public intake
// form). They are account-less by design and must never land in any tenant's
// leads inbox.
export async function createSetupRequest(input: {
  name?: string | null;
  phone: string;
  message?: string | null;
  submitterHash?: string | null;
}) {
  if (shouldSkipDatabaseWrite("setup request insert", input)) {
    return;
  }

  const { error } = await supabaseAdmin.from("setup_requests").insert({
    name: input.name ?? null,
    phone: input.phone,
    message: input.message ?? null,
    submitter_hash: input.submitterHash ?? null,
    status: "new",
  });

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
