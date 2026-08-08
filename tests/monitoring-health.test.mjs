import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../lib/monitoring-health.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new vm.Script(`(function(module,exports){${compiled}\n})`).runInThisContext()(module, module.exports);
const {
  calculateAccountHealth,
  deduplicateMonitoringAlerts,
  monitoringAlertBucketKey,
} = module.exports;

const now = new Date("2026-08-06T18:00:00.000Z");
const recent = "2026-08-06T12:00:00.000Z";
const frequentRecent = "2026-08-06T17:55:00.000Z";

function input(overrides = {}) {
  return {
    accountId: "acct-1",
    callsWithoutLeads: 0,
    missedCallsWithoutTextAttempt: 0,
    smsAttempts: 0,
    smsFailures: 0,
    invalidWebhookSignatures: 0,
    webhookProcessingErrors: 0,
    duplicateEventConflicts: 0,
    recordingOrTranscriptionFailures: 0,
    billingReconciliationFailures: 0,
    phoneNumberCount: 1,
    primaryPhoneNumberCount: 1,
    duplicatePhoneNumberCount: 0,
    operationsMonitoringCronAt: frequentRecent,
    operationsMonitoringCronOk: true,
    transcriptionCronAt: recent,
    transcriptionCronOk: true,
    billingReconciliationAt: recent,
    billingReconciliationCronOk: true,
    retentionCronAt: recent,
    retentionCronOk: true,
    weeklyDigestCronAt: recent,
    weeklyDigestCronOk: true,
    billingReconciliationExpected: true,
    ...overrides,
  };
}

test("healthy pilot account has no actionable monitoring alerts", () => {
  const result = calculateAccountHealth(input(), undefined, now);
  assert.equal(result.status, "healthy");
  assert.equal(result.smsFailureRate, null);
  assert.deepEqual(result.alerts, []);
});

test("pipeline gaps and provider failures become explicit operator alerts", () => {
  const result = calculateAccountHealth(input({
    callsWithoutLeads: 1,
    missedCallsWithoutTextAttempt: 2,
    invalidWebhookSignatures: 1,
    webhookProcessingErrors: 1,
    duplicateEventConflicts: 1,
    recordingOrTranscriptionFailures: 1,
    billingReconciliationFailures: 1,
    phoneNumberCount: 0,
    primaryPhoneNumberCount: 0,
  }), undefined, now);

  assert.equal(result.status, "critical");
  assert.deepEqual(new Set(result.alerts.map((alert) => alert.code)), new Set([
    "call_without_lead",
    "missed_call_without_text_attempt",
    "invalid_webhook_signature",
    "webhook_processing_error",
    "duplicate_event_conflict",
    "recording_or_transcription_failure",
    "billing_reconciliation_failure",
    "phone_number_configuration",
  ]));
});

test("SMS rate waits for the minimum sample and uses the configured threshold", () => {
  const tooSmall = calculateAccountHealth(input({ smsAttempts: 2, smsFailures: 2 }), undefined, now);
  assert.equal(tooSmall.alerts.some((alert) => alert.code === "elevated_sms_failure_rate"), false);

  const elevated = calculateAccountHealth(input({ smsAttempts: 5, smsFailures: 1 }), undefined, now);
  assert.equal(elevated.smsFailureRate, 0.2);
  assert.equal(elevated.alerts.some((alert) => alert.code === "elevated_sms_failure_rate"), true);
});

test("one terminal SMS failure is actionable before the aggregate-rate minimum", () => {
  const result = calculateAccountHealth(input({ smsAttempts: 1, smsFailures: 1 }), undefined, now);
  const terminal = result.alerts.find((alert) => alert.code === "terminal_sms_failure");
  assert.equal(terminal?.severity, "critical");
  assert.equal(result.alerts.some((alert) => alert.code === "elevated_sms_failure_rate"), false);
});

test("cron staleness is job-specific and billing is checked only when expected", () => {
  const result = calculateAccountHealth(input({
    transcriptionCronAt: "2026-08-04T00:00:00.000Z",
    transcriptionCronOk: true,
    weeklyDigestCronAt: "2026-07-20T00:00:00.000Z",
    weeklyDigestCronOk: true,
    billingReconciliationAt: null,
    billingReconciliationCronOk: null,
    billingReconciliationExpected: false,
  }), undefined, now);

  assert.equal(result.alerts.some((alert) => alert.code === "transcription_cron_stale"), true);
  assert.equal(result.alerts.some((alert) => alert.code === "weekly_digest_cron_stale"), true);
  assert.equal(result.alerts.some((alert) => alert.code === "billing_reconciliation_stale"), false);
});

test("accounts awaiting their first cron check-ins do not manufacture stale alerts", () => {
  const result = calculateAccountHealth(input({
    operationsMonitoringCronAt: null,
    operationsMonitoringCronOk: null,
    transcriptionCronAt: null,
    transcriptionCronOk: null,
    weeklyDigestCronAt: null,
    weeklyDigestCronOk: null,
    retentionCronAt: null,
    retentionCronOk: null,
    billingReconciliationAt: null,
    billingReconciliationCronOk: null,
    billingReconciliationExpected: true,
  }), undefined, now);

  assert.equal(result.alerts.some((alert) => alert.code.endsWith("_cron_stale")), false);
  assert.equal(result.alerts.some((alert) => alert.code === "billing_reconciliation_stale"), false);
});

test("failed and stale scheduled jobs remain explicit health alerts", () => {
  const result = calculateAccountHealth(input({
    operationsMonitoringCronAt: "2026-08-06T17:00:00.000Z",
    operationsMonitoringCronOk: true,
    transcriptionCronOk: false,
    retentionCronOk: false,
    weeklyDigestCronOk: false,
  }), undefined, now);

  assert.equal(result.alerts.some((alert) => alert.code === "operations_monitoring_cron_stale"), true);
  assert.equal(result.alerts.some((alert) => alert.code === "transcription_cron_stale"), true);
  assert.equal(result.alerts.some((alert) => alert.code === "retention_cron_stale"), true);
  assert.equal(result.alerts.some((alert) => alert.code === "weekly_digest_cron_stale"), true);
});

test("a current failed billing reconciliation is not duplicated as stale", () => {
  const result = calculateAccountHealth(input({
    billingReconciliationFailures: 1,
    billingReconciliationCronOk: false,
  }), undefined, now);

  assert.equal(result.alerts.filter((alert) => alert.code === "billing_reconciliation_failure").length, 1);
  assert.equal(result.alerts.some((alert) => alert.code === "billing_reconciliation_stale"), false);
});

test("alert deduplication keeps one fingerprint and the higher severity", () => {
  const base = {
    accountId: "acct-1",
    code: "webhook_processing_error",
    title: "Webhook failed",
    detail: "detail",
    owner: "relay",
    recommendedAction: "inspect",
    fingerprint: "acct-1:webhook_processing_error",
  };
  const result = deduplicateMonitoringAlerts([
    { ...base, severity: "warning" },
    { ...base, severity: "critical", detail: "newer critical detail" },
    { ...base, severity: "warning" },
  ]);

  assert.equal(result.length, 1);
  assert.equal(result[0].severity, "critical");
  assert.equal(result[0].detail, "newer critical detail");
});

test("persistent alert keys deduplicate within a time bucket and rotate afterward", () => {
  const alert = { accountId: "acct-1", code: "call_without_lead" };
  const first = monitoringAlertBucketKey(alert, new Date("2026-08-06T01:00:00.000Z"));
  const repeated = monitoringAlertBucketKey(alert, new Date("2026-08-06T22:00:00.000Z"));
  const nextDay = monitoringAlertBucketKey(alert, new Date("2026-08-07T01:00:00.000Z"));

  assert.equal(first, repeated);
  assert.notEqual(first, nextDay);
});

test("monitoring query excludes suppressed provider actions from operational failures", async () => {
  const monitoringSource = await readFile(new URL("../lib/supabase/monitoring.ts", import.meta.url), "utf8");
  assert.match(monitoringSource, /row\.suppressed !== true/);
  assert.match(monitoringSource, /row\.internal_status === "failed"/);
  assert.match(monitoringSource, /account\.accountStatus === "active"/);
  assert.match(monitoringSource, /attemptedLeadIds/);
  assert.match(monitoringSource, /automatic_missed_call_sms/);
  assert.match(monitoringSource, /row\.provider === "twilio"/);
  assert.match(monitoringSource, /recentSmsActions\.filter\(\(row\) => row\.internal_status === "failed"\)/);
  assert.match(monitoringSource, /row\.action !== "scheduled_transcription_retry"/);
});

test("monitoring remains operator-only and does not leak diagnostics into owner pages", async () => {
  const page = await readFile(new URL("../app/ops/monitoring/page.tsx", import.meta.url), "utf8");
  assert.match(page, /requirePlatformOperator\(\)/);
  assert.match(page, /loadOperationsMonitoring\(\)/);
  assert.doesNotMatch(page, /requireAccountUser/);
});
