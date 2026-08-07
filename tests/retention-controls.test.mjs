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
  assert.match(schema, /data_retention_events/);
  assert.match(schema, /delete_account_data/);
  assert.match(inventory, /Questions requiring counsel/);
  assert.match(inventory, /call-recording notice or consent/i);
});
