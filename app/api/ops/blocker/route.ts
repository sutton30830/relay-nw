import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import type { OperationsBlocker } from "@/lib/customer-experience-contract";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import {
  getOpsAccountBySlug,
  recordPlatformAuditEvent,
  setAccountOpsBlocker,
} from "@/lib/supabase";

const BLOCKER_OWNERS = new Set<OperationsBlocker>([
  "none",
  "relay",
  "customer",
  "carrier",
]);

function go(slug: string, result: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?blocker=${result}`);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.blockerManage);
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim().slice(0, 80);
  const blockedByValue = String(form.get("blocked_by") ?? "").trim();
  const note = String(form.get("note") ?? "").trim().slice(0, 240);

  if (!slug) redirect("/ops");
  if (!BLOCKER_OWNERS.has(blockedByValue as OperationsBlocker)) {
    go(slug, "invalid_owner");
  }

  const blockedBy = blockedByValue as OperationsBlocker;
  if (blockedBy !== "none" && note.length < 5) {
    go(slug, "reason_required");
  }

  const account = await getOpsAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");

  try {
    await setAccountOpsBlocker({
      accountId: account.accountId,
      blockedBy,
      note: blockedBy === "none" ? null : note,
      actorUserId: operator.userId,
      actorEmail: operator.email,
    });
    // The RPC already persisted the account audit atomically. Platform audit
    // is useful cross-account context, but cannot turn a successful blocker
    // change into a false failure response.
    void recordPlatformAuditEvent({
      actorUserId: operator.userId,
      actorEmail: operator.email,
      targetAccountId: account.accountId,
      action: blockedBy === "none"
        ? "ops.blocker.cleared"
        : `ops.blocker.${blockedBy}`,
      summary: blockedBy === "none"
        ? `Cleared the operations blocker for ${account.businessName}`
        : `Marked ${account.businessName} blocked by ${blockedBy} — ${note}`,
    }).catch((error) => console.error("Platform blocker audit failed", error));
  } catch (error) {
    console.error("Operations blocker update failed", {
      accountId: account.accountId,
      blockedBy,
      error: error instanceof Error ? error.message : error,
    });
    go(slug, "save_failed");
  }

  go(slug, "saved");
}
