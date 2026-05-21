import { expirePendingForwardingHealthChecks } from "@/lib/supabase";
import { authorizeHealthCheckRequest } from "../_auth";

export async function POST() {
  const auth = await authorizeHealthCheckRequest();
  if (auth.response) return auth.response;

  try {
    const expired = await expirePendingForwardingHealthChecks(auth.session.accountId);
    return Response.json({ ok: true, expired });
  } catch (error) {
    console.error("Failed to expire forwarding health checks", { error });
    return Response.json({ error: "Unable to expire health checks" }, { status: 500 });
  }
}
