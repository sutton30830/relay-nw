import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import {
  getOpsAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  updateAccountBillingRecord,
} from "@/lib/supabase";

// Move a customer between pipeline stages, the way an owner moves a lead
// between categories. Stage is derived from onboarding_status, so each stage
// maps to its representative status. Money-driven stages (active, canceled)
// are deliberately excluded — those move via Activate and Stripe.

import type { AccountOnboardingStatus } from "@/lib/billing";

const STAGE_TO_STATUS: Record<string, { status: AccountOnboardingStatus; label: string }> = {
  kickoff: { status: "requirements_needed", label: "Kickoff" },
  setting_up: { status: "ready_for_carrier", label: "Setting up" },
  carrier_review: { status: "carrier_review", label: "Carrier review" },
  ready_to_activate: { status: "ready_to_activate", label: "Ready" },
  paused: { status: "paused_incomplete", label: "Paused" },
};

export async function POST(request: Request) {
  const operator = await requirePlatformOperator();
  if (operator.role === "support") redirect("/ops");
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim().slice(0, 80);
  const stage = String(form.get("stage") ?? "").trim().slice(0, 40);
  if (!slug) redirect("/ops");

  const account = await getOpsAccountBySlug(slug);
  if (!account) redirect("/ops?stage_moved=account_not_found");

  const target = STAGE_TO_STATUS[stage];
  if (!target) redirect(`/ops/accounts/${encodeURIComponent(slug)}?stage_moved=invalid`);

  try {
    await updateAccountBillingRecord(account.accountId, { onboardingStatus: target.status });
  } catch (error) {
    console.error("Ops stage move failed", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    redirect(`/ops/accounts/${encodeURIComponent(slug)}?stage_moved=save_failed`);
  }

  const summary = `Relay moved ${account.businessName} to ${target.label}`;
  await recordAccountAuditEvents({
    accountId: account.accountId,
    actorUserId: operator.userId,
    actorEmail: operator.email,
    events: [{ action: "ops.stage_moved", summary }],
  });
  await recordPlatformAuditEvent({
    actorUserId: operator.userId,
    actorEmail: operator.email,
    targetAccountId: account.accountId,
    action: "ops.stage_moved",
    summary,
  });

  redirect(`/ops/accounts/${encodeURIComponent(slug)}?stage_moved=saved`);
}
