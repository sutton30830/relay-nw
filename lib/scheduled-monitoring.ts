import "server-only";

import { recordCronCheckIn } from "@/lib/cron-checkins";
import { notifyAdminOperationalIssue } from "@/lib/email";
import {
  monitoringAlertBucketKey,
  type MonitoringAlert,
} from "@/lib/monitoring-health";
import {
  getProviderActionByKey,
  loadOperationsMonitoring,
} from "@/lib/supabase";

const DELIVERED_ALERT_STATUSES = new Set(["accepted", "succeeded", "reconciled"]);

export type ScheduledMonitoringReport = {
  ok: boolean;
  evaluatedAccounts: number;
  actionableAlerts: number;
  sentAlerts: number;
  deduplicatedAlerts: number;
  alertDeliveryFailures: number;
  checkInFailures: number;
  unresolvedInvalidSignatures: number;
  unresolvedWebhookErrors: number;
};

async function deliverAccountAlert(input: {
  row: Awaited<ReturnType<typeof loadOperationsMonitoring>>["rows"][number];
  alert: MonitoringAlert;
  now: Date;
}) {
  const actionKey = monitoringAlertBucketKey(input.alert, input.now);
  const existing = await getProviderActionByKey(input.row.accountId, actionKey);
  if (existing) {
    return {
      sent: false,
      deduplicated: true,
      deliveryFailed: !DELIVERED_ALERT_STATUSES.has(existing.internalStatus),
    };
  }

  const outcome = await notifyAdminOperationalIssue({
    account: {
      accountId: input.row.accountId,
      accountSlug: input.row.accountSlug,
      businessName: input.row.businessName,
    },
    issue: input.alert.title,
    detail: `${input.alert.detail} Next: ${input.alert.recommendedAction}`,
    correlationId: input.alert.fingerprint,
    actionKey,
  });

  return {
    sent: Boolean(outcome.sent),
    deduplicated: false,
    deliveryFailed: !outcome.sent,
  };
}

async function deliverPlatformAlert(input: {
  code: "invalid_webhook_signature" | "webhook_processing_error";
  issue: string;
  detail: string;
  now: Date;
}) {
  const actionKey = monitoringAlertBucketKey({ accountId: "platform", code: input.code }, input.now);
  const outcome = await notifyAdminOperationalIssue({
    issue: input.issue,
    detail: input.detail,
    correlationId: `platform:${input.code}`,
    actionKey,
  });
  return Boolean(outcome.sent);
}

export async function runScheduledOperationsMonitoring(now = new Date()): Promise<ScheduledMonitoringReport> {
  const dashboard = await loadOperationsMonitoring();
  let sentAlerts = 0;
  let deduplicatedAlerts = 0;
  let alertDeliveryFailures = 0;
  let actionableAlerts = 0;
  const failedAccounts = new Set<string>();

  for (const row of dashboard.rows) {
    for (const alert of row.health.alerts) {
      // This route cannot prove its own absence. Sentry's external Cron Monitor
      // handles missed invocations; the database signal remains visible in Ops.
      if (alert.code === "operations_monitoring_cron_stale") continue;
      actionableAlerts += 1;
      const result = await deliverAccountAlert({ row, alert, now });
      if (result.sent) sentAlerts += 1;
      if (result.deduplicated) deduplicatedAlerts += 1;
      if (result.deliveryFailed) {
        alertDeliveryFailures += 1;
        failedAccounts.add(row.accountId);
      }
    }
  }

  if (dashboard.unresolvedInvalidSignatures > 0) {
    actionableAlerts += 1;
    const sent = await deliverPlatformAlert({
      code: "invalid_webhook_signature",
      issue: "Unresolved invalid webhook signatures",
      detail: `${dashboard.unresolvedInvalidSignatures} rejected Twilio signature event${dashboard.unresolvedInvalidSignatures === 1 ? " remains" : "s remain"} unassigned. No tenant was guessed.`,
      now,
    });
    if (sent) sentAlerts += 1;
    else alertDeliveryFailures += 1;
  }

  if (dashboard.unresolvedWebhookErrors > 0) {
    actionableAlerts += 1;
    const sent = await deliverPlatformAlert({
      code: "webhook_processing_error",
      issue: "Unresolved webhook processing errors",
      detail: `${dashboard.unresolvedWebhookErrors} provider callback error${dashboard.unresolvedWebhookErrors === 1 ? " remains" : "s remain"} unassigned. Inspect platform logs and provider identifiers; do not guess a tenant.`,
      now,
    });
    if (sent) sentAlerts += 1;
    else alertDeliveryFailures += 1;
  }

  const runKey = now.toISOString().slice(0, 10);
  const checkIns = await Promise.all(dashboard.rows.map((row) => recordCronCheckIn({
    accountId: row.accountId,
    job: "scheduled_operations_monitoring",
    runKey,
    ok: !failedAccounts.has(row.accountId),
    detail: failedAccounts.has(row.accountId)
      ? "Monitoring evaluated account health, but at least one operator alert was not accepted by email."
      : `Monitoring evaluated ${row.health.alerts.length} current account alert${row.health.alerts.length === 1 ? "" : "s"}.`,
  })));
  const checkInFailures = checkIns.filter((ok) => !ok).length;

  return {
    ok: alertDeliveryFailures === 0 && checkInFailures === 0,
    evaluatedAccounts: dashboard.rows.length,
    actionableAlerts,
    sentAlerts,
    deduplicatedAlerts,
    alertDeliveryFailures,
    checkInFailures,
    unresolvedInvalidSignatures: dashboard.unresolvedInvalidSignatures,
    unresolvedWebhookErrors: dashboard.unresolvedWebhookErrors,
  };
}
