import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import { createStripeRefund } from "@/lib/stripe-billing";
import {
  getOpsBillingAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
} from "@/lib/supabase";

function go(slug: string, result: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?billing_action=${result}`);
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperator();
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim();
  if (!slug) redirect("/ops");
  if (operator.role !== "super_admin") go(slug, "refund_forbidden");
  const account = await getOpsBillingAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");
  if (!account.setupFeePaymentIntentId || account.setupFeeStatus === "waived" || account.setupFeeStatus === "due") {
    go(account.accountSlug, "refund_unavailable");
  }
  const rawAmount = Number(form.get("amount_cents") ?? 0);
  const remaining = Math.max(0, account.setupFeeCents - account.setupFeeRefundedCents);
  const amountCents = Number.isInteger(rawAmount) && rawAmount > 0 ? Math.min(rawAmount, remaining) : null;
  const reason = String(form.get("reason") ?? "Customer requested refund").trim().slice(0, 240) || "Customer requested refund";
  try {
    const refund = await createStripeRefund({
      paymentIntentId: account.setupFeePaymentIntentId,
      amountCents,
      accountId: account.accountId,
      reason,
      idempotencyKey: `relay-setup-refund:${account.accountId}:${account.setupFeeRefundedCents}:${amountCents ?? "remaining"}`,
    });
    const summary = `Started ${refund.amount < remaining ? "partial " : ""}setup-fee refund of $${(refund.amount / 100).toFixed(2)} — ${reason}`;
    await recordAccountAuditEvents({
      accountId: account.accountId,
      actorUserId: operator.userId,
      actorEmail: operator.email,
      events: [{ action: "billing.setup_fee.refund_started", summary }],
    });
    await recordPlatformAuditEvent({
      actorUserId: operator.userId,
      actorEmail: operator.email,
      targetAccountId: account.accountId,
      action: "billing.setup_fee.refund_started",
      summary,
    });
    go(account.accountSlug, "refund_started");
  } catch (error) {
    console.error("Setup-fee refund failed", { accountId: account.accountId, error: error instanceof Error ? error.message : error });
    go(account.accountSlug, "refund_failed");
  }
}
