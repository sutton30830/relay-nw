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
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, {
    filename: path,
  }).runInThisContext()(require, module, module.exports);
  return module.exports;
}

function redirect(location) {
  const error = new Error("NEXT_REDIRECT");
  error.location = location;
  throw error;
}

async function runTeamAction({
  action = "role",
  role = "operator",
  userId = "target-admin",
  targetRole = "super_admin",
  superAdminCount = 1,
} = {}) {
  const calls = { updates: [], audits: [] };
  const { POST } = await loadTsModule("app/api/ops/team/route.ts", {
    "next/navigation": { redirect },
    "@/lib/auth": {
      requirePlatformOperatorAction: async () => ({
        userId: "actor-admin",
        email: "admin@example.com",
        role: "super_admin",
      }),
    },
    "@/lib/ops-actions": { OPS_ACTIONS: { teamManage: "team.manage" } },
    "@/lib/supabase": {
      countActiveSuperAdmins: async () => superAdminCount,
      getPlatformOperatorByUserId: async () => ({
        userId,
        email: "target@example.com",
        role: targetRole,
        status: "active",
      }),
      invitePlatformOperator: async () => {
        throw new Error("unexpected invite");
      },
      updatePlatformOperator: async (input) => calls.updates.push(input),
      recordPlatformAuditEvent: async (input) => calls.audits.push(input),
    },
  });
  const form = new FormData();
  form.set("action", action);
  form.set("role", role);
  form.set("user_id", userId);
  let location = null;
  try {
    await POST(new Request("https://relay.test/api/ops/team", {
      method: "POST",
      body: form,
    }));
  } catch (error) {
    if (error?.message !== "NEXT_REDIRECT") throw error;
    location = error.location;
  }
  return { calls, location };
}

test("the final super admin cannot be demoted or revoked", async () => {
  for (const input of [
    { action: "role", role: "operator" },
    { action: "revoke", role: "super_admin" },
  ]) {
    const { calls, location } = await runTeamAction(input);
    assert.equal(location, "/ops/team?error=last_super_admin");
    assert.deepEqual(calls.updates, []);
    assert.deepEqual(calls.audits, []);
  }
});

test("a super admin can be demoted when another super admin remains", async () => {
  const { calls, location } = await runTeamAction({ superAdminCount: 2 });

  assert.equal(location, "/ops/team?saved=1");
  assert.deepEqual(calls.updates, [{ userId: "target-admin", role: "operator" }]);
  assert.equal(calls.audits[0].action, "platform.operator.role_changed");
  assert.equal(calls.audits[0].targetUserId, "target-admin");
});

test("unknown Operations roles fail closed before persistence", async () => {
  const { calls, location } = await runTeamAction({ role: "owner" });

  assert.equal(location, "/ops/team?error=invalid_request");
  assert.deepEqual(calls.updates, []);
  assert.deepEqual(calls.audits, []);
});
