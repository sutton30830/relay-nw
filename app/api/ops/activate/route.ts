import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import { addTrialDays } from "@/lib/billing";
import { POST as startCheckout } from "@/app/api/ops/billing/checkout/route";
import { getOpsBillingAccountBySlug, recordAccountAuditEvents, recordPlatformAuditEvent, updateAccountBillingRecord } from "@/lib/supabase";

export async function POST(request: Request) {
  const operator = await requirePlatformOperator();
  const form = await request.formData();
  const accountSlug = String(form.get("account_slug") ?? "").trim();
  const action = String(form.get("action") ?? "").trim();
  if (!accountSlug) redirect("/ops");
  if (action === "start_billing") return startCheckout(request);
  const account = await getOpsBillingAccountBySlug(accountSlug);
  if (!account) redirect(`/ops/accounts/${encodeURIComponent(accountSlug)}?activation=account_not_found`);
  if (account.onboardingStatus !== "ready_to_activate") redirect(`/ops/accounts/${encodeURIComponent(account.accountSlug)}?activation=blocked`);
  const days = Math.min(90, Math.max(7, Number(form.get("trial_days") ?? 30) || 30));
  const update = action === "comp"
    ? { billingStatus: "comped" as const, onboardingStatus: "activated" as const, activatedAt: new Date().toISOString(), billingAttentionSince: null }
    : action === "trial"
      ? { billingStatus: "trialing" as const, onboardingStatus: "activated" as const, activatedAt: new Date().toISOString(), trialEndsAt: addTrialDays({ days }), billingAttentionSince: null }
      : null;
  if (!update) redirect(`/ops/accounts/${encodeURIComponent(account.accountSlug)}?activation=invalid_action`);
  await updateAccountBillingRecord(account.accountId, update);
  const summary = action === "comp" ? "Activated account as a comped pilot" : `Activated account with a ${days}-day trial`;
  await recordAccountAuditEvents({ accountId: account.accountId, actorUserId: operator.userId, actorEmail: operator.email, events: [{ action: `billing.activation.${action}`, summary }] });
  await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetAccountId: account.accountId, action: `billing.activation.${action}`, summary });
  redirect(`/ops/accounts/${encodeURIComponent(account.accountSlug)}?activation=${action}`);
}
