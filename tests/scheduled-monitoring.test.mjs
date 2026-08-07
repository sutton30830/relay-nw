import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadTsModule(path, mocks) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier in mocks) return mocks[specifier];
    throw new Error(`Missing test mock for ${specifier} while loading ${path}`);
  };
  new vm.Script(`(function(require,module,exports){${compiled}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

const NOW = new Date("2026-08-06T18:00:00.000Z");
const MISSING_LEAD_ALERT = {
  accountId: "acct-1",
  code: "call_without_lead",
  severity: "critical",
  title: "Missed call did not create a lead",
  detail: "1 missed call exceeded the five-minute grace period without a lead.",
  owner: "relay",
  recommendedAction: "Inspect the original provider event.",
  fingerprint: "acct-1:call_without_lead",
};

function dashboard(alerts = [MISSING_LEAD_ALERT]) {
  return {
    generatedAt: NOW.toISOString(),
    thresholds: {},
    rows: [{
      accountId: "acct-1",
      accountSlug: "demo",
      businessName: "Demo Plumbing",
      health: { status: alerts.length ? "critical" : "healthy", alerts, smsFailureRate: null },
    }],
    unresolvedInvalidSignatures: 0,
    unresolvedWebhookErrors: 0,
  };
}

async function makeRunner({
  alerts = [MISSING_LEAD_ALERT],
  existing = null,
  notifyResult = { sent: true, skipped: false },
  checkInResult = true,
  unresolvedWebhookErrors = 0,
} = {}) {
  const calls = { notifications: [], checkIns: [], lookups: [] };
  const value = dashboard(alerts);
  value.unresolvedWebhookErrors = unresolvedWebhookErrors;
  const module = await loadTsModule("lib/scheduled-monitoring.ts", {
    "server-only": {},
    "@/lib/cron-checkins": {
      recordCronCheckIn: async (input) => {
        calls.checkIns.push(input);
        return checkInResult;
      },
    },
    "@/lib/email": {
      notifyAdminOperationalIssue: async (input) => {
        calls.notifications.push(input);
        return notifyResult;
      },
    },
    "@/lib/monitoring-health": {
      monitoringAlertBucketKey: (alert, now) =>
        `monitoring_alert:${alert.accountId}:${alert.code}:${now.toISOString().slice(0, 10)}`,
    },
    "@/lib/supabase": {
      loadOperationsMonitoring: async () => value,
      getProviderActionByKey: async (accountId, actionKey) => {
        calls.lookups.push({ accountId, actionKey });
        return existing;
      },
    },
  });
  return { ...module, calls };
}

test("scheduled monitoring actively sends a missing-lead alert and checks in", async () => {
  const { runScheduledOperationsMonitoring, calls } = await makeRunner();
  const report = await runScheduledOperationsMonitoring(NOW);

  assert.equal(report.ok, true);
  assert.equal(report.sentAlerts, 1);
  assert.equal(calls.notifications.length, 1);
  assert.match(calls.notifications[0].detail, /provider event/i);
  assert.match(calls.notifications[0].actionKey, /call_without_lead/);
  assert.equal(calls.checkIns[0].job, "scheduled_operations_monitoring");
  assert.equal(calls.checkIns[0].ok, true);
});

test("accepted alert evidence deduplicates repeated monitoring runs", async () => {
  const { runScheduledOperationsMonitoring, calls } = await makeRunner({
    existing: { internalStatus: "accepted" },
  });
  const report = await runScheduledOperationsMonitoring(NOW);

  assert.equal(report.ok, true);
  assert.equal(report.deduplicatedAlerts, 1);
  assert.equal(calls.notifications.length, 0);
});

test("a failed alert delivery makes the scheduled check and response fail visibly", async () => {
  const { runScheduledOperationsMonitoring, calls } = await makeRunner({
    notifyResult: { sent: false, skipped: false, error: new Error("email unavailable") },
  });
  const report = await runScheduledOperationsMonitoring(NOW);

  assert.equal(report.ok, false);
  assert.equal(report.alertDeliveryFailures, 1);
  assert.equal(calls.checkIns[0].ok, false);
});

test("a recovered account has no stale alert delivery and records a healthy check-in", async () => {
  const { runScheduledOperationsMonitoring, calls } = await makeRunner({ alerts: [] });
  const report = await runScheduledOperationsMonitoring(NOW);

  assert.equal(report.ok, true);
  assert.equal(report.actionableAlerts, 0);
  assert.equal(calls.notifications.length, 0);
  assert.equal(calls.checkIns[0].ok, true);
});

test("unassigned webhook processing failures produce a platform alert", async () => {
  const { runScheduledOperationsMonitoring, calls } = await makeRunner({
    alerts: [],
    unresolvedWebhookErrors: 2,
  });
  const report = await runScheduledOperationsMonitoring(NOW);

  assert.equal(report.sentAlerts, 1);
  assert.equal(calls.notifications[0].account, undefined);
  assert.match(calls.notifications[0].issue, /unresolved webhook/i);
});

test("scheduled monitoring route fails closed when cron authentication is absent or wrong", async () => {
  const wrapperCalls = [];
  const module = await loadTsModule("app/api/cron/operations-monitoring/route.ts", {
    "@/lib/cron-monitor": {
      withCronMonitor: async (input) => {
        wrapperCalls.push(input.slug);
        return input.run();
      },
    },
    "@/lib/env": { env: { cronSecret: "secret" } },
    "@/lib/email": { notifyAdminOperationalIssue: async () => ({ sent: true }) },
    "@/lib/monitoring-health": { monitoringAlertBucketKey: () => "key" },
    "@/lib/provider-actions": { sanitizeProviderDiagnostic: () => "safe" },
    "@/lib/scheduled-monitoring": {
      runScheduledOperationsMonitoring: async () => ({ ok: true }),
    },
  });

  const missing = await module.GET(new Request("https://relay.test/api/cron/operations-monitoring"));
  const wrong = await module.GET(new Request("https://relay.test/api/cron/operations-monitoring", {
    headers: { authorization: "Bearer wrong" },
  }));
  const valid = await module.GET(new Request("https://relay.test/api/cron/operations-monitoring", {
    headers: { authorization: "Bearer secret" },
  }));

  assert.equal(missing.status, 401);
  assert.equal(wrong.status, 401);
  assert.equal(valid.status, 200);
  assert.deepEqual(wrapperCalls, ["relay-operations-monitoring"]);
});
