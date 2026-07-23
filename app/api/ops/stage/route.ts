import { redirect } from "next/navigation";
import { requirePlatformOperatorWrite } from "@/lib/auth";
import type { TechnicalSetupStatus } from "@/lib/customer-experience-contract";
import {
  getOpsAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  updateAccountTechnicalSetupStatus,
} from "@/lib/supabase";

// Operators can set only explicit technical holds and reopen setup. A signed
// missed call marks an account live; Stripe derives active and canceled.

const STAGE_TO_STATUS: Record<string, { status: TechnicalSetupStatus; label: string }> = {
  setting_up: { status: "setting_up", label: "Setting up" },
  paused: { status: "paused", label: "Paused" },
  closed: { status: "closed", label: "Closed" },
};

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorWrite();
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim().slice(0, 80);
  const stage = String(form.get("stage") ?? "").trim().slice(0, 40);
  if (!slug) redirect("/ops");

  const account = await getOpsAccountBySlug(slug);
  if (!account) redirect("/ops?stage_moved=account_not_found");

  const target = STAGE_TO_STATUS[stage];
  if (!target) redirect(`/ops/accounts/${encodeURIComponent(slug)}?stage_moved=invalid`);

  try {
    await updateAccountTechnicalSetupStatus(account.accountId, target.status);
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
