import { getForwardingHealthSummary } from "@/lib/supabase";
import { isAuthorizedHealthCheckRequest } from "../_auth";

export async function GET() {
  if (!(await isAuthorizedHealthCheckRequest())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await getForwardingHealthSummary();
    return Response.json(summary);
  } catch (error) {
    console.error("Failed to load forwarding health status", { error });
    return Response.json({ error: "Unable to load health status" }, { status: 500 });
  }
}
