import type { AuditDraft } from "@/lib/audit";
import { isPlaceholderSupabaseConfig, shouldSkipDatabaseWrite, supabaseAdmin } from "./client";
import { assertAccountId } from "./tenant";

export type AccountAuditEvent = {
  id: string;
  action: string;
  summary: string;
  actorEmail: string | null;
  createdAt: string;
};

// Recording an audit event must never break the action it describes. If the
// table is missing (deploy ahead of migration) or the insert fails, we warn and
// move on rather than failing the settings save.
export async function recordAccountAuditEvents(input: {
  accountId: string;
  actorUserId: string | null;
  actorEmail: string | null;
  events: AuditDraft[];
}): Promise<void> {
  if (input.events.length === 0) return;

  const accountId = assertAccountId(input.accountId, "recordAccountAuditEvents");

  if (shouldSkipDatabaseWrite("account audit event", input)) {
    return;
  }

  const rows = input.events.map((event) => ({
    account_id: accountId,
    actor_user_id: input.actorUserId,
    actor_email: input.actorEmail,
    action: event.action,
    summary: event.summary,
  }));

  const { error } = await supabaseAdmin.from("account_audit_events").insert(rows);

  if (error) {
    console.warn("Could not record account audit events (run supabase.sql if the table is missing).", {
      accountId,
      error: error.message,
    });
  }
}

export async function getAccountAuditEvents(
  inputAccountId: string,
  limit = 10,
): Promise<AccountAuditEvent[]> {
  const accountId = assertAccountId(inputAccountId, "getAccountAuditEvents");

  if (isPlaceholderSupabaseConfig()) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("account_audit_events")
    .select("id, action, summary, actor_email, created_at")
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    // Non-fatal: the settings page still renders without the activity list.
    console.warn("Could not load account audit events.", { accountId, error: error.message });
    return [];
  }

  return (data ?? []).map((row) => ({
    id: row.id as string,
    action: row.action as string,
    summary: row.summary as string,
    actorEmail: (row.actor_email as string | null) ?? null,
    createdAt: row.created_at as string,
  }));
}

export type AccountTeamMember = {
  email: string | null;
  role: "owner" | "admin" | "viewer";
  createdAt: string;
};

export async function getAccountTeamMembers(inputAccountId: string): Promise<AccountTeamMember[]> {
  const accountId = assertAccountId(inputAccountId, "getAccountTeamMembers");

  if (isPlaceholderSupabaseConfig()) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("account_users")
    .select("email, role, created_at")
    .eq("account_id", accountId)
    .order("created_at", { ascending: true });

  if (error) {
    console.warn("Could not load account team members.", { accountId, error: error.message });
    return [];
  }

  return (data ?? []).map((row) => ({
    email: (row.email as string | null) ?? null,
    role: row.role as AccountTeamMember["role"],
    createdAt: row.created_at as string,
  }));
}
