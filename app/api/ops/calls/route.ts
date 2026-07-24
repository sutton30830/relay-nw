import { redirect } from "next/navigation";
import { requirePlatformOperatorWrite } from "@/lib/auth";
import type { TechnicalSetupStatus } from "@/lib/customer-experience-contract";
import {
  getOpsAccountBySlug,
  recordAccountAuditEvents,
  recordPlatformAuditEvent,
  updateAccountTechnicalSetupStatus,
} from "@/lib/supabase";

// Operators can set only an explicit call hold or reopen setup. A signed real
// missed call is still required to prove readiness after a hold is cleared.

const CALL_CONTROL_TO_STATUS: Record<string, { status: TechnicalSetupStatus; label: string }> = {
  setting_up: { status: "setting_up", label: "Call setup resumed" },
  paused: { status: "paused", label: "Calls paused" },
};

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorWrite();
  const form = await request.formData();
  const slug = String(form.get("account_slug") ?? "").trim().slice(0, 80);
  const callControl = String(form.get("call_control") ?? "").trim().slice(0, 40);
  if (!slug) redirect("/ops");

  const account = await getOpsAccountBySlug(slug);
  if (!account) redirect("/ops?calls=account_not_found");

  const target = CALL_CONTROL_TO_STATUS[callControl];
  if (!target) redirect(`/ops/accounts/${encodeURIComponent(slug)}?calls=invalid`);

  try {
    await updateAccountTechnicalSetupStatus(account.accountId, target.status);
  } catch (error) {
    console.error("Ops call hold update failed", {
      accountId: account.accountId,
      error: error instanceof Error ? error.message : error,
    });
    redirect(`/ops/accounts/${encodeURIComponent(slug)}?calls=save_failed`);
  }

  const summary = `${target.label} for ${account.businessName}`;
  await recordAccountAuditEvents({
    accountId: account.accountId,
    actorUserId: operator.userId,
    actorEmail: operator.email,
    events: [{ action: "ops.calls.hold_changed", summary }],
  });
  await recordPlatformAuditEvent({
    actorUserId: operator.userId,
    actorEmail: operator.email,
    targetAccountId: account.accountId,
    action: "ops.calls.hold_changed",
    summary,
  });

  redirect(`/ops/accounts/${encodeURIComponent(slug)}?calls=saved`);
}
