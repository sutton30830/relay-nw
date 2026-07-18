import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import {
  addTrialDays,
  canApplyOperatorBillingOverride,
  normalizeOperatorTrialDays,
  type OperatorBillingOverrideAction,
} from "@/lib/billing";
import {
  getOpsBillingAccountBySlug,
  recordPlatformAuditEvent,
  recordAccountAuditEvents,
  updateAccountBillingRecord,
} from "@/lib/supabase";

const VALID_ACTIONS = new Set<OperatorBillingOverrideAction>([
  "comp",
  "uncomp",
  "grant_trial",
  "extend_trial",
  "end_trial_now",
  "waive_setup_fee",
  "require_setup_fee",
]);

function readString(formData: FormData, key: string, maxLength = 120) {
  return String(formData.get(key) ?? "").trim().slice(0, maxLength);
}

function readAction(formData: FormData): OperatorBillingOverrideAction | null {
  const action = readString(formData, "action", 40);
  return VALID_ACTIONS.has(action as OperatorBillingOverrideAction)
    ? action as OperatorBillingOverrideAction
    : null;
}

function redirectWith(status: string, accountSlug?: string) {
  const params = new URLSearchParams({ billing_action: status });
  if (accountSlug) params.set("account", accountSlug);
  redirect(`/ops/billing?${params.toString()}`);
}

function actionSummary(action: OperatorBillingOverrideAction, days?: number) {
  if (action === "comp") return "Comped account";
  if (action === "uncomp") return "Removed comp and reset account to not started";
  if (action === "grant_trial") return `Granted ${days ?? 30}-day trial`;
  if (action === "extend_trial") return `Extended trial by ${days ?? 30} days`;
  if (action === "waive_setup_fee") return "Waived the one-time setup fee for this account";
  if (action === "require_setup_fee") return "Restored the one-time setup fee requirement";
  return "Ended manual trial";
}

export async function POST(request: Request) {
  const session = await requirePlatformOperator();
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

  if ((action === "waive_setup_fee" || action === "require_setup_fee") && account.setupFeeStatus === "paid") {
    return redirectWith("setup_fee_already_paid", account.accountSlug);
  }

  const days = normalizeOperatorTrialDays(readString(formData, "trial_days", 8));
  const waiverReason = readString(formData, "waiver_reason", 240);
  const auditSummary = actionSummary(action, days);

  try {
    if (action === "waive_setup_fee") {
      await updateAccountBillingRecord(account.accountId, {
        setupFeeStatus: "waived",
        setupFeeWaivedAt: new Date().toISOString(),
        setupFeeWaiverReason: waiverReason || "Pilot waiver; operator did not provide a reason.",
      });
    } else if (action === "require_setup_fee") {
      await updateAccountBillingRecord(account.accountId, {
        setupFeeStatus: "due",
        setupFeeWaivedAt: null,
        setupFeeWaiverReason: null,
      });
    } else if (action === "comp") {
      await updateAccountBillingRecord(account.accountId, {
        billingStatus: "comped",
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        billingAttentionSince: null,
      });
    } else if (action === "uncomp" || action === "end_trial_now") {
      await updateAccountBillingRecord(account.accountId, {
        billingStatus: "not_started",
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        billingAttentionSince: null,
      });
    } else {
      await updateAccountBillingRecord(account.accountId, {
        billingStatus: "trialing",
        trialEndsAt: addTrialDays({
          trialEndsAt: action === "extend_trial" ? account.trialEndsAt : null,
          days,
        }),
        cancelAtPeriodEnd: false,
        billingAttentionSince: null,
      });
    }

    await recordAccountAuditEvents({
      accountId: account.accountId,
      actorUserId: session.userId,
      actorEmail: session.email,
      events: [
        {
          action: `billing.operator.${action}`,
          summary: auditSummary,
        },
      ],
    });
    await recordPlatformAuditEvent({
      actorUserId: session.userId,
      actorEmail: session.email,
      targetAccountId: account.accountId,
      action: `billing.operator.${action}`,
      summary: auditSummary,
    });
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
