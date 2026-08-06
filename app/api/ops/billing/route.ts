import { redirect } from "next/navigation";
import { requirePlatformOperatorWrite } from "@/lib/auth";
import { canApplyOperatorBillingOverride } from "@/lib/billing";
import {
  OPS_ACTIONS,
  canPerformOpsAction,
  hasExplicitOpsConfirmation,
  type OpsAction,
} from "@/lib/ops-actions";
import {
  clearCustomerGoLiveApproval,
  getOpsBillingAccountBySlug,
  recordPlatformAuditEvent,
  setAccountBillingPolicy,
  setAccountCommercialOffer,
  setAccountFreeAccess,
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

function actionSummary(action: OperatorBillingPolicyAction, reviewDate: string | null) {
  if (action === "comp") {
    return `Started or updated free access with no setup fee, card, or Stripe subscription; ${
      reviewDate ? `review scheduled for ${reviewDate}` : "no review date scheduled"
    }`;
  }
  if (action === "uncomp") return "Ended free access without creating a charge or subscription";
  if (action === "waive_setup_fee") return "Waived the one-time setup fee for this account";
  if (action === "require_setup_fee") return "Restored the one-time setup fee requirement";
  return "Updated billing policy";
}

function permissionFor(action: OperatorBillingPolicyAction): OpsAction {
  if (action === "comp") return OPS_ACTIONS.serviceComp;
  if (action === "uncomp") return OPS_ACTIONS.serviceUncomp;
  if (action === "waive_setup_fee") return OPS_ACTIONS.setupFeeWaive;
  return OPS_ACTIONS.setupFeeRequire;
}

function policyFor(action: OperatorBillingPolicyAction, offer: "standard" | "founding_pilot") {
  if (action === "waive_setup_fee") return "setup_fee_waived" as const;
  if (action === "uncomp" && offer === "founding_pilot") return "setup_fee_waived" as const;
  return "standard" as const;
}

function optionalReviewDate(formData: FormData) {
  const value = readString(formData, "free_access_review_at", 10);
  if (!value) return { valid: true as const, date: null, timestamp: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { valid: false as const, date: value, timestamp: null };
  }
  const timestamp = `${value}T23:59:59.999Z`;
  const parsed = new Date(timestamp);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value ||
    parsed.getTime() <= Date.now()
  ) {
    return { valid: false as const, date: value, timestamp: null };
  }
  return { valid: true as const, date: value, timestamp };
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
  if (!canPerformOpsAction(session.role, permissionFor(action))) {
    return redirectWith("forbidden", accountSlug);
  }
  if (!hasExplicitOpsConfirmation(formData.get("confirmation"))) {
    return redirectWith("confirmation_required", accountSlug);
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
  const review = optionalReviewDate(formData);
  if (action === "comp" && !review.valid) {
    return redirectWith("review_date_invalid", account.accountSlug);
  }

  const auditSummary = actionSummary(
    action,
    action === "comp" && review.valid ? review.date : null,
  );

  try {
    // Record the super-admin authorization before changing commercial state.
    // The account-scoped RPC records the applied result in the same transaction
    // as the policy change, giving every successful exception both audit views.
    await recordPlatformAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      targetAccountId: account.accountId,
      action: `billing.operator.${action}.authorized`,
      summary: `${auditSummary} authorized — ${reason}`,
    }, { required: true });

    if (action === "comp" && review.valid) {
      await setAccountFreeAccess({
        accountId: account.accountId,
        reviewAt: review.timestamp,
        reason,
        actorUserId: session.userId,
        actorEmail: session.email,
      });
    } else if (action === "waive_setup_fee" || action === "require_setup_fee") {
      await setAccountCommercialOffer({
        accountId: account.accountId,
        offer: action === "waive_setup_fee" ? "founding_pilot" : "standard",
        reason,
        actorUserId: session.userId,
        actorEmail: session.email,
      });
    } else {
      await setAccountBillingPolicy({
        accountId: account.accountId,
        policy: policyFor(action, account.commercialOffer),
        reason,
        actorUserId: session.userId,
        actorEmail: session.email,
      });
    }

    await clearCustomerGoLiveApproval(account.accountId);

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
