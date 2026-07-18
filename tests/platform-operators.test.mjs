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
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;

  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier in mocks) return mocks[specifier];
    throw new Error(`Missing test mock for ${specifier} while loading ${path}`);
  };

  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

function makeSupabase({ row = null, error = null } = {}) {
  const inserts = [];
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: row, error }),
    insert: (payload) => {
      inserts.push(payload);
      return Promise.resolve({ data: null, error: null });
    },
  };

  return { client: { from: () => builder }, inserts };
}

test("active platform operator resolves independently of account membership", async () => {
  const supabase = makeSupabase({
    row: {
      user_id: "user-1",
      email: "srlowry21@gmail.com",
      role: "super_admin",
      status: "active",
    },
  });
  const operators = await loadTsModule("lib/supabase/operators.ts", {
    "./client": {
      supabaseAdmin: supabase.client,
      shouldSkipDatabaseWrite: () => false,
    },
  });

  const result = await operators.getPlatformOperatorByUserId("user-1");

  assert.deepEqual(result, {
    userId: "user-1",
    email: "srlowry21@gmail.com",
    role: "super_admin",
    status: "active",
  });
});

test("revoked and malformed operator rows fail closed", async () => {
  for (const row of [
    { user_id: "user-1", email: "ops@example.com", role: "operator", status: "revoked" },
    { user_id: "user-1", email: "ops@example.com", role: "owner", status: "active" },
  ]) {
    const supabase = makeSupabase({ row });
    const operators = await loadTsModule("lib/supabase/operators.ts", {
      "./client": {
        supabaseAdmin: supabase.client,
        shouldSkipDatabaseWrite: () => false,
      },
    });

    assert.equal(await operators.getPlatformOperatorByUserId("user-1"), null);
  }
});

test("platform audit events record target user and account without blocking callers", async () => {
  const supabase = makeSupabase();
  const operators = await loadTsModule("lib/supabase/operators.ts", {
    "./client": {
      supabaseAdmin: supabase.client,
      shouldSkipDatabaseWrite: () => false,
    },
  });

  await operators.recordPlatformAuditEvent({
    actorUserId: "admin-1",
    actorEmail: "srlowry21@gmail.com",
    targetUserId: "operator-2",
    targetAccountId: "acct-1",
    action: "platform.operator.granted",
    summary: "Granted Operations access",
  });

  assert.deepEqual(supabase.inserts, [{
    actor_user_id: "admin-1",
    actor_email: "srlowry21@gmail.com",
    action: "platform.operator.granted",
    summary: "Granted Operations access",
    target_user_id: "operator-2",
    target_account_id: "acct-1",
  }]);
});

test("SQL creates explicit platform operator and platform audit tables", async () => {
  const sql = await readFile(new URL("../supabase.sql", import.meta.url), "utf8");

  assert.match(sql, /create table if not exists public\.platform_operators/);
  assert.match(sql, /platform_operators_role_check/);
  assert.match(sql, /platform_operators_status_check/);
  assert.match(sql, /create table if not exists public\.platform_audit_events/);
  assert.match(sql, /srlowry21@gmail\.com/);
});
