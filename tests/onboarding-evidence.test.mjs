import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadEvidenceStore() {
  const writes = [];
  const source = await readFile(new URL("../lib/supabase/onboarding-evidence.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const supabaseAdmin = {
    from: (table) => ({
      upsert: async (payload, options) => {
        writes.push({ table, kind: "upsert", payload, options });
        return { error: null };
      },
    }),
  };
  const require = (id) => {
    if (id === "./client") return { isPlaceholderSupabaseConfig: () => false, supabaseAdmin };
    if (id === "./tenant") {
      return {
        assertAccountId: (value) => {
          if (!value) throw new Error("Missing account id");
          return value;
        },
      };
    }
    throw new Error(`Missing mock: ${id}`);
  };
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports){${compiled}\n})`).runInThisContext()(require, module, module.exports);
  return { ...module.exports, writes };
}

test("Twilio delivered callbacks persist account-scoped SMS evidence", async () => {
  const store = await loadEvidenceStore();
  await store.recordSmsOnboardingEvidence({
    accountId: "acct-a",
    messageSid: "SM_delivered",
    status: "delivered",
    occurredAt: "2026-08-05T20:00:00Z",
  });

  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].table, "account_onboarding_evidence");
  assert.equal(store.writes[0].payload.account_id, "acct-a");
  assert.equal(store.writes[0].payload.sms_delivery_message_sid, "SM_delivered");
});

test("only Twilio's landline/non-SMS error certifies the failure test", async () => {
  const store = await loadEvidenceStore();
  await store.recordSmsOnboardingEvidence({
    accountId: "acct-a",
    messageSid: "SM_filtered",
    status: "undelivered",
    errorCode: "30007",
  });
  assert.equal(store.writes.length, 0);

  await store.recordSmsOnboardingEvidence({
    accountId: "acct-a",
    messageSid: "SM_landline",
    status: "undelivered",
    errorCode: "30006",
  });
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].payload.non_sms_failure_code, "30006");
  assert.equal(store.writes[0].payload.non_sms_failure_message_sid, "SM_landline");
});

test("evidence writes fail closed without a tenant account id", async () => {
  const store = await loadEvidenceStore();
  await assert.rejects(
    store.recordOwnerNotificationSent({ accountId: "", providerId: "email-1" }),
    /Missing account id/,
  );
  assert.equal(store.writes.length, 0);
});
