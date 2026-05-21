import { getForwardingHealthSummary } from "@/lib/supabase";
import { authorizeHealthCheckRequest } from "../_auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await authorizeHealthCheckRequest();
  if (auth.response) return auth.response;

  try {
    const summary = await getForwardingHealthSummary(auth.session.accountId);
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
