import { shouldSkipDatabaseWrite, supabaseAdmin } from "./client";

export type PlatformOperatorRole = "super_admin" | "operator" | "support";
export type PlatformOperatorStatus = "active" | "revoked";

export type PlatformOperator = {
  userId: string;
  email: string;
  role: PlatformOperatorRole;
  status: PlatformOperatorStatus;
};

function normalizeRole(value: unknown): PlatformOperatorRole | null {
  return value === "super_admin" || value === "operator" || value === "support" ? value : null;
}

function normalizeStatus(value: unknown): PlatformOperatorStatus | null {
  return value === "active" || value === "revoked" ? value : null;
}

export async function getPlatformOperatorByUserId(userId: string): Promise<PlatformOperator | null> {
  if (!userId.trim()) return null;

  const { data, error } = await supabaseAdmin
    .from("platform_operators")
    .select("user_id, email, role, status")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    if (error.message.includes("platform_operators")) {
      console.warn("Platform operator table is missing. Run supabase.sql before enabling Operations access.");
      return null;
    }

    throw error;
  }

  if (!data) return null;

  const role = normalizeRole(data.role);
  const status = normalizeStatus(data.status);
  if (!role || !status || status !== "active") return null;

  return {
    userId: String(data.user_id),
    email: String(data.email ?? ""),
    role,
    status,
  };
}

export async function recordPlatformAuditEvent(input: {
  actorUserId: string;
  actorEmail: string | null;
  action: string;
  summary: string;
  targetUserId?: string | null;
  targetAccountId?: string | null;
}): Promise<void> {
  if (shouldSkipDatabaseWrite("platform audit event", input)) return;

  const { error } = await supabaseAdmin.from("platform_audit_events").insert({
    actor_user_id: input.actorUserId,
    actor_email: input.actorEmail,
    action: input.action,
    summary: input.summary,
    target_user_id: input.targetUserId ?? null,
    target_account_id: input.targetAccountId ?? null,
  });

  if (error) {
    console.warn("Could not record platform audit event (run supabase.sql if the table is missing).", {
      action: input.action,
      error: error.message,
    });
  }
}
