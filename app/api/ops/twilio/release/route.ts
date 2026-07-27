import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import { OPS_ACTIONS, hasExplicitOpsConfirmation } from "@/lib/ops-actions";
import {
  getOpsAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  releaseAccountPhoneNumbers,
} from "@/lib/supabase";

function go(slug: string, value: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?number=${value}`);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.releaseExistingNumber);
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim();
  const reason = String(form.get("reason") ?? "").trim();
  if (!slug) redirect("/ops");
  if (reason.length < 5 || reason.length > 240) go(slug, "reason_required");
  if (!hasExplicitOpsConfirmation(form.get("confirmation"))) go(slug, "confirmation_required");

  const account = await getOpsAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");
  if (account.accountStatus !== "archived" || account.technicalStatus !== "closed") {
    go(slug, "release_requires_closed");
  }

  try {
    const numbers = await releaseAccountPhoneNumbers(account.accountId);
    if (numbers.length === 0) go(account.accountSlug, "none");
    const summary = `Detached Relay number${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")} from ${account.businessName}; still owned in Twilio and available for reassignment. Reason: ${reason}`;
    await recordAccountAuditEvents({
      accountId: account.accountId,
      actorUserId: operator.userId,
      actorEmail: operator.email,
      events: [{ action: "provisioning.number_released", summary }],
    }, { required: true });
    await recordPlatformAuditEvent({
      actorUserId: operator.userId,
      actorEmail: operator.email,
      targetAccountId: account.accountId,
      action: "provisioning.number_released",
      summary,
    }, { required: true });
  } catch (error) {
    console.error("Relay number release failed", { accountId: account.accountId, error: error instanceof Error ? error.message : error });
    go(account.accountSlug, "release_failed");
  }
  go(account.accountSlug, "released");
}
