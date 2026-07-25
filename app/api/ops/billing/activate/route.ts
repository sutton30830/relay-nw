import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import { activateStripeTrialForAccount } from "@/lib/billing-activation";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import {
  getOpsBillingAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
} from "@/lib/supabase";

function go(slug: string, result: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?billing_action=${encodeURIComponent(result)}`);
}

function visibleResult(status: string) {
  if (status === "created") return "trial_started";
  if (status === "already_started") return "trial_already_started";
  if (status === "setup_fee_required") return "setup_fee_required";
  if (status === "payment_method_required") return "payment_method_required";
  if (status === "restart_required") return "restart_required";
  if (status === "comped") return "account_comped";
  if (status === "conflicting_subscription") return "subscription_conflict";
  return "activation_not_eligible";
}

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.trialActivate);
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim().slice(0, 80);
  if (!slug) redirect("/ops");

  const account = await getOpsBillingAccountBySlug(slug);
  if (!account) go(slug, "account_not_found");

  let resultStatus: string;
  try {
    // This is the only operator path that can request initial trial creation.
    // The Phase 1 operation re-reads every authority-backed prerequisite and
    // owns the Stripe idempotency key; no request field can manufacture state.
    const result = await activateStripeTrialForAccount(account.accountId);
    const summary = result.status === "created"
      ? "Requested the idempotent Stripe trial activation after all prerequisites passed"
      : `Checked idempotent Stripe trial activation: ${result.status}`;

    await recordAccountAuditEvents({
      accountId: account.accountId,
      actorUserId: operator.userId,
      actorEmail: operator.email,
      events: [{ action: "billing.trial.activation_checked", summary }],
    });
    await recordPlatformAuditEvent({
      actorUserId: operator.userId,
      actorEmail: operator.email,
      targetAccountId: account.accountId,
      action: "billing.trial.activation_checked",
      summary,
    });
    resultStatus = visibleResult(result.status);
  } catch (error) {
    console.error("Operator Stripe trial activation failed", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    go(account.accountSlug, "activation_failed");
  }
  go(account.accountSlug, resultStatus);
}
