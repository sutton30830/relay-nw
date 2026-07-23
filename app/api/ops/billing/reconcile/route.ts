import { redirect } from "next/navigation";
import { requirePlatformOperatorWrite } from "@/lib/auth";
import { reconcileStripeBillingAccount } from "@/lib/billing-reconciliation";
import {
  getOpsBillingAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
} from "@/lib/supabase";

function go(slug: string, result: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?billing_action=${result}`);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorWrite();
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim();
  if (!slug) redirect("/ops");
  const account = await getOpsBillingAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");
  try {
    await reconcileStripeBillingAccount(account);
    const summary = "Reconciled billing state from Stripe";
    await recordAccountAuditEvents({ accountId: account.accountId, actorUserId: operator.userId, actorEmail: operator.email, events: [{ action: "billing.reconciled", summary }] });
    await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetAccountId: account.accountId, action: "billing.reconciled", summary });
    go(account.accountSlug, "reconciled");
  } catch (error) {
    console.error("Stripe reconciliation failed", { accountId: account.accountId, error: error instanceof Error ? error.message : error });
    go(account.accountSlug, "reconcile_failed");
  }
}
