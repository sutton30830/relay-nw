import { redirect } from "next/navigation";
import { requirePlatformOperatorAction } from "@/lib/auth";
import { OPS_ACTIONS } from "@/lib/ops-actions";
import {
  countActiveSuperAdmins,
  getPlatformOperatorByUserId,
  invitePlatformOperator,
  recordPlatformAuditEvent,
  updatePlatformOperator,
  type PlatformOperatorRole,
} from "@/lib/supabase";

const ROLES = new Set<PlatformOperatorRole>(["super_admin", "operator", "support"]);

export async function POST(request: Request) {
  const operator = await requirePlatformOperatorAction(OPS_ACTIONS.teamManage);
  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  const role = String(form.get("role") ?? "operator") as PlatformOperatorRole;
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const userId = String(form.get("user_id") ?? "").trim();

  if (action === "invite" && (!email || !ROLES.has(role))) {
    redirect("/ops/team?error=invalid_request");
  }
  if ((action === "role" || action === "revoke") && !userId) {
    redirect("/ops/team?error=invalid_request");
  }
  if (action === "role" && !ROLES.has(role)) {
    redirect("/ops/team?error=invalid_request");
  }
  if (action !== "invite" && action !== "role" && action !== "revoke") {
    redirect("/ops/team?error=invalid_request");
  }
  if (userId === operator.userId && action === "revoke") {
    redirect("/ops/team?error=self_revoke");
  }

  let targetMissing = false;
  let wouldRemoveLastSuperAdmin = false;
  try {
    if (action === "role" || action === "revoke") {
      const target = await getPlatformOperatorByUserId(userId);
      targetMissing = !target;
      if (target &&
        target.role === "super_admin" &&
        (action === "revoke" || role !== "super_admin")
      ) {
        wouldRemoveLastSuperAdmin = await countActiveSuperAdmins() <= 1;
      }
    }
  } catch (error) {
    console.error("Operator team guard failed", {
      action,
      error: error instanceof Error ? error.message : error,
    });
    redirect("/ops/team?error=save_failed");
  }

  if (targetMissing) {
    redirect("/ops/team?error=operator_not_found");
  }
  if (wouldRemoveLastSuperAdmin) {
    redirect("/ops/team?error=last_super_admin");
  }

  try {
    if (action === "invite") {
      await invitePlatformOperator({ email, role, actorUserId: operator.userId });
      await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, action: "platform.operator.invited", summary: `Invited ${email} to Operations as ${role}` });
    } else {
      await updatePlatformOperator({ userId, ...(action === "revoke" ? { status: "revoked" as const } : { role }) });
      await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetUserId: userId, action: action === "revoke" ? "platform.operator.revoked" : "platform.operator.role_changed", summary: action === "revoke" ? "Revoked Operations access" : `Changed Operations role to ${role}` });
    }
  } catch (error) {
    console.error("Operator team action failed", { action, error: error instanceof Error ? error.message : error });
    redirect("/ops/team?error=save_failed");
  }
  redirect("/ops/team?saved=1");
}
