import { expirePendingForwardingHealthChecks } from "@/lib/supabase";
import { isAuthorizedHealthCheckRequest } from "../_auth";

export async function POST() {
  if (!(await isAuthorizedHealthCheckRequest())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const expired = await expirePendingForwardingHealthChecks();
    return Response.json({ ok: true, expired });
  } catch (error) {
    console.error("Failed to expire forwarding health checks", { error });
    return Response.json({ error: "Unable to expire health checks" }, { status: 500 });
  }
}
