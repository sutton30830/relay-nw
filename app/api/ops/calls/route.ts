import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import {
  OPS_ACTIONS,
  hasExplicitOpsConfirmation,
  type OpsAction,
} from "@/lib/ops-actions";
import {
  getOpsAccountBySlug,
  getOpsBillingAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  updateAccountOperationalState,
} from "@/lib/supabase";

type AccountControl =
  | "pause_onboarding"
  | "resume_onboarding"
  | "pause_paid_service"
  | "close_account"
  | "reopen_account";

const ACTION_POLICY: Record<AccountControl, OpsAction> = {
  pause_onboarding: OPS_ACTIONS.onboardingPause,
  resume_onboarding: OPS_ACTIONS.onboardingResume,
  pause_paid_service: OPS_ACTIONS.paidServicePause,
  close_account: OPS_ACTIONS.accountClose,
  reopen_account: OPS_ACTIONS.accountReopen,
};

const NONTERMINAL_SUBSCRIPTIONS = new Set([
  "incomplete",
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "paused",
]);

const SENSITIVE_CONTROLS = new Set<AccountControl>([
  "pause_paid_service",
  "close_account",
  "reopen_account",
]);

function isAccountControl(value: string): value is AccountControl {
  return Object.hasOwn(ACTION_POLICY, value);
}

function go(slug: string, result: string): never {
  redirect(`/ops/accounts/${encodeURIComponent(slug)}?calls=${result}`);
}

export async function POST(request: Request) {
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim().slice(0, 80);
  const controlValue = String(form.get("account_control") ?? "").trim().slice(0, 40);
  if (!slug) redirect("/ops");
  if (!isAccountControl(controlValue)) go(slug, "invalid");
  const control = controlValue;
  const operator = await requirePlatformOperatorAction(ACTION_POLICY[control]);

  const [account, billing] = await Promise.all([
    getOpsAccountBySlug(slug),
    getOpsBillingAccountBySlug(slug),
  ]);
  if (!account || !billing) go(slug, "account_not_found");

  const hasPaidService = Boolean(
    billing.stripeSubscriptionStatus &&
    NONTERMINAL_SUBSCRIPTIONS.has(billing.stripeSubscriptionStatus),
  );
  if (
    (control === "pause_onboarding" || control === "resume_onboarding") &&
    account.accountStatus !== "active"
  ) {
    go(slug, "account_requires_reopen");
  }
  if (control === "resume_onboarding" && account.technicalStatus !== "paused") {
    go(slug, "invalid_state");
  }
  if (control === "pause_onboarding" && account.technicalStatus === "closed") {
    go(slug, "account_requires_reopen");
  }
  if (control === "pause_onboarding" && hasPaidService) {
    go(slug, "paid_service_requires_super_admin");
  }
  if (control === "pause_paid_service" && !hasPaidService) {
    go(slug, "not_paid_service");
  }
  if (control === "pause_paid_service" && account.accountStatus !== "active") {
    go(slug, "invalid_state");
  }

  const reason = String(form.get("reason") ?? "").trim().slice(0, 240);
  if (SENSITIVE_CONTROLS.has(control)) {
    if (reason.length < 5) go(slug, "reason_required");
    if (!hasExplicitOpsConfirmation(form.get("confirmation"))) {
      go(slug, "confirmation_required");
    }
  }

  const summary = control === "pause_onboarding"
    ? `Paused onboarding for ${account.businessName}`
    : control === "resume_onboarding"
      ? `Resumed onboarding for ${account.businessName}; call readiness must be proven again`
      : control === "pause_paid_service"
        ? `Authorized an explicit paid-service pause for ${account.businessName} — ${reason}`
        : control === "close_account"
          ? `Authorized closing ${account.businessName} without changing Stripe — ${reason}`
          : `Authorized reopening ${account.businessName}; call readiness must be proven again — ${reason}`;
  const auditAction = `ops.account.${control}`;
  try {
    if (SENSITIVE_CONTROLS.has(control)) {
      await recordPlatformAuditEvent({
        actorUserId: operator.userId,
        actorEmail: operator.email,
        targetAccountId: account.accountId,
        action: `${auditAction}.authorized`,
        summary,
      }, { required: true });
      await recordAccountAuditEvents({
        accountId: account.accountId,
        actorUserId: operator.userId,
        actorEmail: operator.email,
        events: [{ action: `${auditAction}.authorized`, summary }],
      }, { required: true });
    }

    await updateAccountOperationalState({
      accountId: account.accountId,
      ...(control === "pause_onboarding"
        ? { technicalStatus: "paused" as const }
        : control === "resume_onboarding"
          ? { technicalStatus: "setting_up" as const }
          : control === "pause_paid_service"
            ? { accountStatus: "paused" as const, technicalStatus: "paused" as const }
            : control === "close_account"
              ? { accountStatus: "archived" as const, technicalStatus: "closed" as const }
              : { accountStatus: "active" as const, technicalStatus: "setting_up" as const }),
    });
  } catch (error) {
    console.error("Ops account control failed", {
      accountId: account.accountId,
      control,
      error: error instanceof Error ? error.message : error,
    });
    go(slug, "save_failed");
  }

  if (!SENSITIVE_CONTROLS.has(control)) {
    await recordAccountAuditEvents({
      accountId: account.accountId,
      actorUserId: operator.userId,
      actorEmail: operator.email,
      events: [{ action: auditAction, summary }],
    });
    await recordPlatformAuditEvent({
      actorUserId: operator.userId,
      actorEmail: operator.email,
      targetAccountId: account.accountId,
      action: auditAction,
      summary,
    });
  }

  go(slug, "saved");
}
