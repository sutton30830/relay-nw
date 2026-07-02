import { shouldSkipDatabaseWrite, supabaseAdmin, throwIfSupabaseError } from "./client";

// Setup requests are prospects for Relay NW itself (from the public intake
// form). They are account-less by design and must never land in any tenant's
// leads inbox.
export async function createSetupRequest(input: {
  name?: string | null;
  phone: string;
  message?: string | null;
}) {
  if (shouldSkipDatabaseWrite("setup request insert", input)) {
    return;
  }

  const { error } = await supabaseAdmin.from("setup_requests").insert({
    name: input.name ?? null,
    phone: input.phone,
    message: input.message ?? null,
    status: "new",
  });

  throwIfSupabaseError(error);
}
