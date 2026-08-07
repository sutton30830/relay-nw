import { env } from "@/lib/env";
import { runOperationalRetention } from "@/lib/retention";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(request: Request) {
  if (!env.cronSecret) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${env.cronSecret}`;
}
export async function GET(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const execute = new URL(request.url).searchParams.get("execute") === "true";
  try {
    const report = await runOperationalRetention({ dryRun: !execute });
    return Response.json(report, {
      status: report.providerFailures > 0 ? 207 : 200,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Retention job failed." }, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
