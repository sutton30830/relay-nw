import { withCronMonitor } from "@/lib/cron-monitor";
import { env } from "@/lib/env";
import { notifyAdminOperationalIssue } from "@/lib/email";
import { monitoringAlertBucketKey } from "@/lib/monitoring-health";
import { sanitizeProviderDiagnostic } from "@/lib/provider-actions";
import { runScheduledOperationsMonitoring } from "@/lib/scheduled-monitoring";

export const runtime = "nodejs";
export const maxDuration = 300;

async function runAuthorizedMonitoring() {
  const now = new Date();
  try {
    const report = await runScheduledOperationsMonitoring(now);
    return Response.json(report, {
      status: report.ok ? 200 : 502,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const detail = sanitizeProviderDiagnostic(error);
    await notifyAdminOperationalIssue({
      issue: "Scheduled operations monitoring failed",
      detail,
      correlationId: "scheduled-operations-monitoring",
      actionKey: monitoringAlertBucketKey({
        accountId: "platform",
        code: "webhook_processing_error",
      }, now),
    });
    return Response.json({ error: "Scheduled operations monitoring failed." }, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}

export async function GET(request: Request) {
  if (!env.cronSecret) {
    return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${env.cronSecret}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  return withCronMonitor({
    slug: "relay-operations-monitoring",
    schedule: { type: "crontab", value: "*/5 * * * *" },
    checkInMarginMinutes: 2,
    maxRuntimeMinutes: 5,
    run: runAuthorizedMonitoring,
  });
}
