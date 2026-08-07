import { recordCronCheckIn } from "@/lib/cron-checkins";
import { withCronMonitor } from "@/lib/cron-monitor";
import { notifyAdminOperationalIssue } from "@/lib/email";
import { env } from "@/lib/env";
import { monitoringAlertBucketKey } from "@/lib/monitoring-health";
import { sanitizeProviderDiagnostic } from "@/lib/provider-actions";
import { runOperationalRetention, type OperationalRetentionReport } from "@/lib/retention";
import { getAccountConfigByAccountId, listActiveAccountIds } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function notifyRetentionFailures(report: OperationalRetentionReport, now: Date) {
  const failuresByAccount = new Map<string, number>();
  for (const failure of report.providerFailureEvidence) {
    failuresByAccount.set(failure.accountId, (failuresByAccount.get(failure.accountId) ?? 0) + 1);
  }

  const outcomes = await Promise.all([...failuresByAccount.entries()].map(async ([accountId, failures]) => {
    let account = null;
    try {
      account = await getAccountConfigByAccountId(accountId);
    } catch (error) {
      console.error("Retention alert account lookup failed", {
        accountId,
        error: sanitizeProviderDiagnostic(error),
      });
    }

    return notifyAdminOperationalIssue({
      account,
      issue: "Retention provider deletion failed",
      detail: `${failures} Twilio message deletion${failures === 1 ? "" : "s"} failed. Tenant-scoped provider evidence was retained for an idempotent retry; no customer message will be resent.`,
      correlationId: `retention:${accountId}`,
      actionKey: monitoringAlertBucketKey({ accountId, code: "retention_cron_stale" }, now),
    });
  }));

  return outcomes.every((outcome) => outcome.sent);
}

async function runAuthorizedRetention(request: Request) {
  const execute = new URL(request.url).searchParams.get("execute") === "true";
  const now = new Date();
  let activeAccountIds: string[] = [];

  try {
    activeAccountIds = await listActiveAccountIds();
    const report = await runOperationalRetention({ dryRun: !execute, now });
    const failedAccountIds = new Set(report.providerFailureEvidence.map((failure) => failure.accountId));
    const alertsAccepted = report.providerFailures === 0
      ? true
      : await notifyRetentionFailures(report, now);

    let checkInFailures = 0;
    if (execute) {
      const runKey = now.toISOString().slice(0, 10);
      const checkIns = await Promise.all(activeAccountIds.map((accountId) => recordCronCheckIn({
        accountId,
        job: "scheduled_retention",
        runKey,
        ok: !failedAccountIds.has(accountId),
        detail: failedAccountIds.has(accountId)
          ? "At least one tenant-scoped Twilio message deletion failed; evidence remains retryable."
          : "Operational retention completed without a tenant-scoped provider deletion failure.",
      })));
      checkInFailures = checkIns.filter((ok) => !ok).length;
    }

    const ok = report.providerFailures === 0 && alertsAccepted && checkInFailures === 0;
    return Response.json({ ok, ...report, checkInFailures }, {
      status: ok ? 200 : 502,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const detail = sanitizeProviderDiagnostic(error);
    console.error("Scheduled retention failed", { error: detail });
    const runKey = now.toISOString().slice(0, 10);
    await Promise.all(activeAccountIds.map((accountId) => recordCronCheckIn({
      accountId,
      job: "scheduled_retention",
      runKey,
      ok: false,
      detail: "The scheduled retention job failed before it could complete.",
    })));
    await notifyAdminOperationalIssue({
      issue: "Scheduled retention failed",
      detail,
      correlationId: "scheduled-retention",
      actionKey: monitoringAlertBucketKey({
        accountId: "platform",
        code: "retention_cron_stale",
      }, now),
    });
    return Response.json({ error: "Retention job failed." }, {
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
    slug: "relay-operational-retention",
    schedule: { type: "crontab", value: "45 16 * * *" },
    checkInMarginMinutes: 10,
    maxRuntimeMinutes: 5,
    run: () => runAuthorizedRetention(request),
  });
}
