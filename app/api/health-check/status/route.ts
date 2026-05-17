import { getForwardingHealthSummary } from "@/lib/supabase";
import { isAuthorizedHealthCheckRequest } from "../_auth";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAuthorizedHealthCheckRequest())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await getForwardingHealthSummary();
    return Response.json(summary, {
      headers: {
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Failed to load forwarding health status", { error });
    return Response.json({ error: "Unable to load health status" }, { status: 500 });
  }
}
