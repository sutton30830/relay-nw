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

  const script = new vm.Script(
    `(function(require, module, exports) { ${compiled}\n})`,
    { filename: path },
  );
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

async function loadLeadStore(rpcResult) {
  const calls = [];
  const store = await loadTsModule("lib/supabase/leads.ts", {
    "./client": {
      isPlaceholderSupabaseConfig: () => false,
      shouldSkipDatabaseWrite: () => false,
      throwIfSupabaseError: (error) => {
        if (error) throw error;
      },
      supabaseAdmin: {
        rpc: async (name, input) => {
          calls.push({ name, input });
          return rpcResult;
        },
      },
    },
    "./tenant": {
      assertAccountId: (value) => value,
    },
    "./types": {},
  });

  return { store, calls };
}

test("signed real missed call uses the atomic RPC and can mark setup live", async () => {
  const { store, calls } = await loadLeadStore({
    data: [{
      inserted: true,
      lead_id: "lead-1",
      lead_created_at: "2026-07-22T12:00:00.000Z",
      became_live: true,
    }],
    error: null,
  });

  const result = await store.createMissedCallLeadIfNew({
    accountId: "acct-1",
    callSid: "CA_1",
    phone: "+12065550123",
    message: null,
    twilioSignatureValid: true,
  });

  assert.deepEqual(calls, [{
    name: "create_missed_call_lead_and_mark_live",
    input: {
      p_account_id: "acct-1",
      p_call_sid: "CA_1",
      p_phone: "+12065550123",
      p_message: null,
      p_twilio_signature_valid: true,
    },
  }]);
  assert.deepEqual(result, {
    inserted: true,
    leadId: "lead-1",
    createdAt: "2026-07-22T12:00:00.000Z",
    becameLive: true,
  });
});

test("unsigned override is explicitly denied technical go-live", async () => {
  const { store, calls } = await loadLeadStore({
    data: [{
      inserted: true,
      lead_id: "lead-2",
      lead_created_at: "2026-07-22T12:01:00.000Z",
      became_live: false,
    }],
    error: null,
  });

  const result = await store.createMissedCallLeadIfNew({
    accountId: "acct-1",
    callSid: "CA_2",
    phone: "+12065550124",
    message: "Missed call",
    twilioSignatureValid: false,
  });

  assert.equal(calls[0].input.p_twilio_signature_valid, false);
  assert.equal(result.inserted, true);
  assert.equal(result.becameLive, false);
});

test("duplicate CallSid cannot transition technical setup", async () => {
  const { store } = await loadLeadStore({
    data: [{
      inserted: false,
      lead_id: null,
      lead_created_at: null,
      became_live: false,
    }],
    error: null,
  });

  const result = await store.createMissedCallLeadIfNew({
    accountId: "acct-1",
    callSid: "CA_duplicate",
    phone: "+12065550125",
    message: null,
    twilioSignatureValid: true,
  });

  assert.deepEqual(result, {
    inserted: false,
    leadId: null,
    createdAt: null,
    becameLive: false,
  });
});

test("migration only transitions pre-live states and protects RPC execution", async () => {
  const migration = await readFile(
    new URL("../docs/migrations/2026-07-22-technical-setup-state.sql", import.meta.url),
    "utf8",
  );

  assert.match(
    migration,
    /onboarding_status in \('setting_up', 'waiting_for_forwarding'\)/,
  );
  assert.match(migration, /if p_twilio_signature_valid then/);
  assert.match(migration, /on conflict \(account_id, call_sid\)/);
  assert.match(migration, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant execute on function[\s\S]*to service_role/);
  assert.doesNotMatch(
    migration,
    /requirements_due_at|billing_status\s*=|stripe_subscription_status\s*=|a2p_registration_status\s*=/,
  );
});

test("repair migration removes the obsolete column reference and preserves RPC permissions", async () => {
  const migration = await readFile(
    new URL(
      "../docs/migrations/2026-07-23-repair-missed-call-activation.sql",
      import.meta.url,
    ),
    "utf8",
  );

  const functionDefinition = migration.split("commit;")[0];
  assert.match(functionDefinition, /create or replace function public\.create_missed_call_lead_and_mark_live/);
  assert.doesNotMatch(functionDefinition, /requirements_due_at/);
  assert.match(functionDefinition, /revoke all on function[\s\S]*from public, anon, authenticated/);
  assert.match(functionDefinition, /grant execute on function[\s\S]*to service_role/);
});
