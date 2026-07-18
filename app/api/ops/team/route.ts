import { redirect } from "next/navigation";
import { requirePlatformOperator } from "@/lib/auth";
import { countActiveSuperAdmins, invitePlatformOperator, recordPlatformAuditEvent, updatePlatformOperator, type PlatformOperatorRole } from "@/lib/supabase";

const ROLES = new Set<PlatformOperatorRole>(["super_admin", "operator", "support"]);

export async function POST(request: Request) {
  const operator = await requirePlatformOperator();
  if (operator.role !== "super_admin") redirect("/ops/team?error=forbidden");
  const form = await request.formData();
  const action = String(form.get("action") ?? "");
  const role = String(form.get("role") ?? "operator") as PlatformOperatorRole;
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const userId = String(form.get("user_id") ?? "").trim();

  try {
    if (action === "invite" && email && ROLES.has(role)) {
      await invitePlatformOperator({ email, role, actorUserId: operator.userId });
      await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, action: "platform.operator.invited", summary: `Invited ${email} to Operations as ${role}` });
    } else if ((action === "role" || action === "revoke") && userId) {
      if (userId === operator.userId && action === "revoke") redirect("/ops/team?error=self_revoke");
      if (action === "revoke" && await countActiveSuperAdmins() <= 1) redirect("/ops/team?error=last_super_admin");
      await updatePlatformOperator({ userId, ...(action === "revoke" ? { status: "revoked" as const } : { role }) });
      await recordPlatformAuditEvent({ actorUserId: operator.userId, actorEmail: operator.email, targetUserId: userId, action: action === "revoke" ? "platform.operator.revoked" : "platform.operator.role_changed", summary: action === "revoke" ? "Revoked Operations access" : `Changed Operations role to ${role}` });
    }
  } catch (error) {
    console.error("Operator team action failed", { action, error: error instanceof Error ? error.message : error });
    redirect("/ops/team?error=save_failed");
  }
  redirect("/ops/team?saved=1");
}
