import type { AuditDraft } from "@/lib/audit";
import { shouldSkipDatabaseWrite, supabaseAdmin } from "./client";
import { assertAccountId } from "./tenant";

// The audit trail is recorded server-side (a durable compliance record of when
// texting/settings changed and by whom) but not surfaced to the account owner —
// support/ops read it directly, and it's the foundation for a future ops view.

// Recording an audit event must never break the action it describes. If the
// table is missing (deploy ahead of migration) or the insert fails, we warn and
// move on rather than failing the settings save.
export async function recordAccountAuditEvents(input: {
  accountId: string;
  actorUserId: string | null;
  actorEmail: string | null;
  events: AuditDraft[];
}, options?: {
  required?: boolean;
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
    if (options?.required) {
      throw error;
    }
  }
}
