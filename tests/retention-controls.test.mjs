import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadCore() {
  const source = await readFile(new URL("../lib/retention-core.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`)
    .runInThisContext()(() => { throw new Error("retention core has no runtime dependencies"); }, module, module.exports);
  return module.exports;
}

const { runAccountDeletion } = await loadCore();
const ACCOUNT_ID = "11111111-1111-1111-1111-111111111111";
const ACTOR_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function dependencies(overrides = {}) {
  const calls = [];
  const deps = {
    loadTarget: async (accountId) => ({ accountId, accountStatus: "archived", technicalStatus: "closed" }),
    wasDeletionCompleted: async () => false,
    preview: async () => ({ recordings: 1, messages: 1, greetingFiles: 1, databaseRows: { leads: 2 } }),
    listProviderResources: async (accountId) => [
      { accountId, sid: "RE00000000000000000000000000000000", kind: "recording" },
      { accountId, sid: "SM00000000000000000000000000000000", kind: "message" },
    ],
    deleteProviderResource: async (resource) => { calls.push(["provider", resource.kind, resource.sid]); return "deleted"; },
    deleteGreetingFiles: async () => { calls.push(["greetings"]); return { deleted: 1, failed: [] }; },
    deleteDatabaseAccount: async () => { calls.push(["database"]); return { leads: 2 }; },
    recordAction: async (input) => { calls.push(["audit", input.status]); },
    ...overrides,
  };
  return { deps, calls };
}

function run(deps, extra = {}) {
  return runAccountDeletion({
    accountId: ACCOUNT_ID,
    actorUserId: ACTOR_ID,
    actorEmail: "operator@example.com",
    dryRun: false,
    dependencies: deps,
    ...extra,
  });
}

test("account deletion rejects cross-tenant provider candidates before destructive calls", async () => {
  let providerCalls = 0;
  const { deps } = dependencies({
    listProviderResources: async () => [{
      accountId: "22222222-2222-2222-2222-222222222222",
      sid: "RE00000000000000000000000000000000",
      kind: "recording",
    }],
    deleteProviderResource: async () => { providerCalls += 1; return "deleted"; },
  });
  await assert.rejects(run(deps), /crossed a tenant boundary/);
  assert.equal(providerCalls, 0);
});

test("dry run reports boundaries without provider, storage, database, or audit writes", async () => {
  const { deps, calls } = dependencies();
  const result = await run(deps, { dryRun: true });
  assert.equal(result.status, "dry_run");
  assert.deepEqual(result.preview.databaseRows, { leads: 2 });
  assert.deepEqual(calls, []);
});

test("completed account deletion is idempotent when the account row is already gone", async () => {
  const { deps, calls } = dependencies({
    loadTarget: async () => null,
    wasDeletionCompleted: async () => true,
  });
  const result = await run(deps);
  assert.equal(result.status, "already_deleted");
  assert.deepEqual(calls, []);
});

test("partial provider failure is recorded and keeps tenant database data for retry", async () => {
  const { deps, calls } = dependencies({
    deleteProviderResource: async (resource) => {
      calls.push(["provider", resource.kind]);
      if (resource.kind === "recording") throw new Error("Twilio unavailable");
      return "deleted";
    },
  });
  const result = await run(deps);
  assert.equal(result.status, "partial_failure");
  assert.equal(result.providerFailures.length, 1);
  assert.equal(calls.some(([kind]) => kind === "database"), false);
  assert.deepEqual(calls.at(-1), ["audit", "failed"]);
});

test("database failure after provider cleanup is recorded and remains retryable", async () => {
  const { deps, calls } = dependencies({
    deleteDatabaseAccount: async () => { calls.push(["database"]); throw new Error("transaction failed"); },
  });
  const result = await run(deps);
  assert.equal(result.status, "partial_failure");
  assert.deepEqual(result.providerFailures, [{ kind: "database", identifier: ACCOUNT_ID }]);
  assert.deepEqual(calls.at(-1), ["audit", "failed"]);
});

test("execution boundary requires both archived account and closed technical state", async () => {
  for (const target of [
    { accountId: ACCOUNT_ID, accountStatus: "active", technicalStatus: "closed" },
    { accountId: ACCOUNT_ID, accountStatus: "archived", technicalStatus: "paused" },
  ]) {
    const { deps, calls } = dependencies({ loadTarget: async () => target });
    await assert.rejects(run(deps), /archived and technically closed/);
    assert.deepEqual(calls, []);
  }
});

test("successful deletion removes providers before the tenant database transaction", async () => {
  const { deps, calls } = dependencies();
  const result = await run(deps);
  assert.equal(result.status, "deleted");
  assert.deepEqual(calls.map(([kind]) => kind), ["provider", "provider", "greetings", "database"]);
});

test("scheduled retention keeps dry run as default and scrubs both inbound body copies", async () => {
  const [route, retention, schema, inventory] = await Promise.all([
    readFile(new URL("../app/api/cron/retention/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/retention.ts", import.meta.url), "utf8"),
    readFile(new URL("../supabase.sql", import.meta.url), "utf8"),
    readFile(new URL("../docs/data-retention-inventory.md", import.meta.url), "utf8"),
  ]);
  assert.match(route, /get\("execute"\) === "true"/);
  assert.match(route, /dryRun: !execute/);
  assert.match(retention, /from\("inbound_messages"\)\.update\(\{ body: null \}\)/);
  assert.match(retention, /from\("messages"\)\.update\(\{ body: null \}\)\.eq\("direction", "inbound"\)/);
  assert.match(retention, /from\("webhook_events"\)\.delete\(\)/);
  assert.match(retention, /retention_delete_twilio_message/);
  assert.match(retention, /retryEligibility: "automatic"/);
  assert.match(schema, /data_retention_events/);
  assert.match(schema, /delete_account_data/);
  assert.match(inventory, /Questions requiring counsel/);
  assert.match(inventory, /call-recording notice or consent/i);
});

async function loadRoute(path, mocks) {
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

function retentionRouteMocks(report) {
  const calls = { alerts: [], checkIns: [] };
  return {
    calls,
    mocks: {
      "@/lib/cron-checkins": {
        recordCronCheckIn: async (input) => {
          calls.checkIns.push(input);
          return true;
        },
      },
      "@/lib/cron-monitor": {
        withCronMonitor: async (input) => input.run(),
      },
      "@/lib/email": {
        notifyAdminOperationalIssue: async (input) => {
          calls.alerts.push(input);
          return { sent: true, skipped: false };
        },
      },
      "@/lib/env": { env: { cronSecret: "secret" } },
      "@/lib/monitoring-health": {
        monitoringAlertBucketKey: ({ accountId, code }) => `monitoring_alert:${accountId}:${code}:bucket`,
      },
      "@/lib/provider-actions": {
        sanitizeProviderDiagnostic: (error) => error instanceof Error ? error.message : String(error),
      },
      "@/lib/retention": {
        runOperationalRetention: async () => report,
      },
      "@/lib/supabase": {
        listActiveAccountIds: async () => [ACCOUNT_ID],
        getAccountConfigByAccountId: async () => ({
          accountId: ACCOUNT_ID,
          accountSlug: "demo",
          businessName: "Demo Plumbing",
        }),
      },
    },
  };
}

function operationalReport(overrides = {}) {
  return {
    dryRun: false,
    cutoffs: { webhookEvents: "2026-07-01", inboundMessageBodies: "2026-05-01" },
    candidates: { webhookEvents: 1, inboundMessageBodies: 1, twilioMessages: 1 },
    deleted: { webhookEvents: 1, inboundMessageBodies: 1, twilioMessages: 1 },
    providerFailures: 0,
    providerFailureEvidence: [],
    ...overrides,
  };
}

test("retention provider failure returns non-2xx, alerts once, and records a failed check-in", async () => {
  const { mocks, calls } = retentionRouteMocks(operationalReport({
    deleted: { webhookEvents: 1, inboundMessageBodies: 1, twilioMessages: 0 },
    providerFailures: 1,
    providerFailureEvidence: [{
      accountId: ACCOUNT_ID,
      provider: "twilio",
      resourceType: "message",
      providerIdentifier: "SM00000000000000000000000000000000",
    }],
  }));
  const { GET } = await loadRoute("app/api/cron/retention/route.ts", mocks);
  const response = await GET(new Request("https://relay.test/api/cron/retention?execute=true", {
    headers: { authorization: "Bearer secret" },
  }));
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.ok, false);
  assert.equal(calls.alerts.length, 1);
  assert.match(calls.alerts[0].actionKey, /retention_cron_stale/);
  assert.equal(calls.checkIns.length, 1);
  assert.equal(calls.checkIns[0].ok, false);
});

test("a later clean retention retry recovers to 200 and a successful check-in", async () => {
  const { mocks, calls } = retentionRouteMocks(operationalReport());
  const { GET } = await loadRoute("app/api/cron/retention/route.ts", mocks);
  const response = await GET(new Request("https://relay.test/api/cron/retention?execute=true", {
    headers: { authorization: "Bearer secret" },
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(calls.alerts.length, 0);
  assert.equal(calls.checkIns[0].ok, true);
});

test("retention cron rejects missing or invalid authentication before work", async () => {
  const { mocks, calls } = retentionRouteMocks(operationalReport());
  const { GET } = await loadRoute("app/api/cron/retention/route.ts", mocks);
  const response = await GET(new Request("https://relay.test/api/cron/retention?execute=true"));

  assert.equal(response.status, 401);
  assert.deepEqual(calls.checkIns, []);
  assert.deepEqual(calls.alerts, []);
});
