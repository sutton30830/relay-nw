import { redirect } from "next/navigation";
import { requirePlatformOperatorWrite } from "@/lib/auth";
import { canApplyOperatorBillingOverride } from "@/lib/billing";
import {
  getOpsBillingAccountBySlug,
  recordPlatformAuditEvent,
  setAccountBillingPolicy,
} from "@/lib/supabase";

const VALID_ACTIONS = new Set([
  "comp",
  "uncomp",
  "waive_setup_fee",
  "require_setup_fee",
]);

type OperatorBillingPolicyAction = "comp" | "uncomp" | "waive_setup_fee" | "require_setup_fee";

function readString(formData: FormData, key: string, maxLength = 120) {
  return String(formData.get(key) ?? "").trim().slice(0, maxLength);
}

function readAction(formData: FormData): OperatorBillingPolicyAction | null {
  const action = readString(formData, "action", 40);
  return VALID_ACTIONS.has(action as OperatorBillingPolicyAction)
    ? action as OperatorBillingPolicyAction
    : null;
}

function redirectWith(status: string, accountSlug?: string) {
  if (accountSlug) {
    redirect(`/ops/accounts/${encodeURIComponent(accountSlug)}?billing_action=${encodeURIComponent(status)}`);
  }
  redirect(`/ops?billing_action=${encodeURIComponent(status)}`);
}

function actionSummary(action: OperatorBillingPolicyAction) {
  if (action === "comp") return "Comped account";
  if (action === "uncomp") return "Removed comp";
  if (action === "waive_setup_fee") return "Waived the one-time setup fee for this account";
  if (action === "require_setup_fee") return "Restored the one-time setup fee requirement";
  return "Updated billing policy";
}

function policyFor(action: OperatorBillingPolicyAction) {
  if (action === "comp") return "comped" as const;
  if (action === "waive_setup_fee") return "setup_fee_waived" as const;
  return "standard" as const;
}

export async function POST(request: Request) {
  const session = await requirePlatformOperatorWrite();
  const formData = await request.formData();
  const accountSlug = readString(formData, "account_slug", 80);
  const action = readAction(formData);

  if (!accountSlug) {
    return redirectWith("missing_account");
  }

  if (!action) {
    return redirectWith("invalid_action", accountSlug);
  }

  const account = await getOpsBillingAccountBySlug(accountSlug);
  if (!account) {
    return redirectWith("account_not_found", accountSlug);
  }

  if (!canApplyOperatorBillingOverride(account)) {
    return redirectWith("override_blocked", account.accountSlug);
  }

  if (
    (action === "waive_setup_fee" || action === "require_setup_fee") &&
    (account.firstPaidAt || account.setupFeeStatus === "paid")
  ) {
    return redirectWith("setup_fee_already_paid", account.accountSlug);
  }

  const reason = readString(formData, "reason", 240);
  if (reason.length < 5) {
    return redirectWith("reason_required", account.accountSlug);
  }

  const auditSummary = actionSummary(action);

  try {
    await setAccountBillingPolicy({
      accountId: account.accountId,
      policy: policyFor(action),
      reason,
      actorUserId: session.userId,
      actorEmail: session.email,
    });

    // The policy helper writes the required account audit record atomically.
    // This platform record is useful context, but must never turn a completed
    // commercial exception into an apparent failure.
    void recordPlatformAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      targetAccountId: account.accountId,
      action: `billing.operator.${action}`,
      summary: auditSummary,
    }).catch((error) => console.error("Platform billing audit failed", error));
  } catch (error) {
    console.error("Operator billing override failed", {
      accountSlug: account.accountSlug,
      action,
      error: error instanceof Error ? error.message : error,
    });
    return redirectWith("save_failed", account.accountSlug);
  }

  return redirectWith(action, account.accountSlug);
}
