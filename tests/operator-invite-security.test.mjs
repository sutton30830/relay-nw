import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadOperators(client) {
  const source = await readFile(new URL("../lib/supabase/operators.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  const require = (specifier) => {
    if (specifier === "./client") {
      return { shouldSkipDatabaseWrite: () => false, supabaseAdmin: client };
    }
    throw new Error(`Missing mock for ${specifier}`);
  };
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`)
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

function makeClient(invite) {
  const operators = [];
  const calls = [];

  function query(table) {
    const filters = [];
    let updatePayload = null;
    const builder = {
      update: (payload) => {
        updatePayload = payload;
        return builder;
      },
      eq: (column, value) => {
        filters.push((row) => row[column] === value);
        return builder;
      },
      gte: (column, value) => {
        filters.push((row) => String(row[column]) >= String(value));
        return builder;
      },
      select: () => builder,
      maybeSingle: async () => {
        const row = table === "platform_operator_invites" ? invite : null;
        if (!row || !filters.every((filter) => filter(row))) {
          return { data: null, error: null };
        }
        if (updatePayload) Object.assign(row, updatePayload);
        return { data: { ...row }, error: null };
      },
      upsert: async (payload) => {
        calls.push({ table, operation: "upsert", payload });
        if (table === "platform_operators") operators.push(payload);
        return { error: null };
      },
      then: (resolve) => {
        if (table === "platform_operator_invites" && invite && filters.every((filter) => filter(invite))) {
          if (updatePayload) Object.assign(invite, updatePayload);
        }
        return Promise.resolve({ error: null }).then(resolve);
      },
    };
    return builder;
  }

  return {
    client: {
      from: (table) => {
        calls.push({ table, operation: "from" });
        return query(table);
      },
    },
    calls,
    operators,
  };
}

test("operator invite requires a verified email and claims a fresh invite once", async () => {
  const invite = {
    email: "operator@example.com",
    role: "operator",
    status: "pending",
    created_at: new Date().toISOString(),
    claimed_at: null,
  };
  const harness = makeClient(invite);
  const operators = await loadOperators(harness.client);

  await operators.claimPlatformOperatorInvite({
    userId: "user-unconfirmed",
    email: invite.email,
    emailConfirmedAt: null,
  });
  assert.equal(harness.calls.length, 0);

  await operators.claimPlatformOperatorInvite({
    userId: "user-confirmed",
    email: invite.email,
    emailConfirmedAt: new Date().toISOString(),
  });
  assert.equal(invite.status, "claimed");
  assert.deepEqual(harness.operators, [{
    user_id: "user-confirmed",
    email: invite.email,
    role: "operator",
    status: "active",
  }]);

  await operators.claimPlatformOperatorInvite({
    userId: "second-user",
    email: invite.email,
    emailConfirmedAt: new Date().toISOString(),
  });
  assert.equal(harness.operators.length, 1);
});

test("operator invite expires after seven days", async () => {
  const invite = {
    email: "stale@example.com",
    role: "super_admin",
    status: "pending",
    created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    claimed_at: null,
  };
  const harness = makeClient(invite);
  const operators = await loadOperators(harness.client);

  await operators.claimPlatformOperatorInvite({
    userId: "user-stale",
    email: invite.email,
    emailConfirmedAt: new Date().toISOString(),
  });

  assert.equal(invite.status, "pending");
  assert.deepEqual(harness.operators, []);
});
