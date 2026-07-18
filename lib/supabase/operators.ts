import { shouldSkipDatabaseWrite, supabaseAdmin } from "./client";

export type PlatformOperatorRole = "super_admin" | "operator" | "support";
export type PlatformOperatorStatus = "active" | "revoked";

export type PlatformOperator = {
  userId: string;
  email: string;
  role: PlatformOperatorRole;
  status: PlatformOperatorStatus;
  createdAt?: string | null;
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
    .select("user_id, email, role, status, created_at")
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
    ...(typeof data.created_at === "string" ? { createdAt: data.created_at } : {}),
  };
}

export async function claimPlatformOperatorInvite(input: { userId: string; email: string | null }) {
  const email = input.email?.trim().toLowerCase();
  if (!email) return;
  const { data, error } = await supabaseAdmin.from("platform_operator_invites").select("email, role, status").eq("email", email).eq("status", "pending").maybeSingle();
  if (error || !data) return;
  const role = normalizeRole(data.role);
  if (!role) return;
  await supabaseAdmin.from("platform_operators").upsert({ user_id: input.userId, email, role, status: "active" }, { onConflict: "user_id" });
  await supabaseAdmin.from("platform_operator_invites").update({ status: "claimed", claimed_at: new Date().toISOString() }).eq("email", email).eq("status", "pending");
}

export async function listPlatformOperators(): Promise<PlatformOperator[]> {
  const { data, error } = await supabaseAdmin
    .from("platform_operators")
    .select("user_id, email, role, status, created_at")
    .order("created_at", { ascending: true });
  if (error) {
    if (error.message.includes("platform_operators")) return [];
    throw error;
  }
  return (data ?? []).flatMap((row) => {
    const role = normalizeRole(row.role);
    const status = normalizeStatus(row.status);
    if (!role || !status) return [];
    return [{ userId: String(row.user_id), email: String(row.email ?? ""), role, status, createdAt: typeof row.created_at === "string" ? row.created_at : null }];
  });
}

export async function invitePlatformOperator(input: { email: string; role: PlatformOperatorRole; actorUserId: string }) {
  const { error } = await supabaseAdmin.from("platform_operator_invites").upsert({
    email: input.email.trim().toLowerCase(), role: input.role, status: "pending", created_by: input.actorUserId,
  }, { onConflict: "email" });
  if (error) throw error;
}

export async function updatePlatformOperator(input: { userId: string; role?: PlatformOperatorRole; status?: PlatformOperatorStatus }) {
  const payload: Record<string, string> = {};
  if (input.role) payload.role = input.role;
  if (input.status) payload.status = input.status;
  const { error } = await supabaseAdmin.from("platform_operators").update(payload).eq("user_id", input.userId);
  if (error) throw error;
}

export async function countActiveSuperAdmins() {
  const { count, error } = await supabaseAdmin.from("platform_operators").select("user_id", { count: "exact", head: true }).eq("role", "super_admin").eq("status", "active");
  if (error) throw error;
  return count ?? 0;
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
