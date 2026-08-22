import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadTsModule(path, mocks = {}) {
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
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

const opsActions = await loadTsModule("lib/ops-actions.ts");

function redirectRecorder(calls) {
  return {
    redirect: (url) => {
      calls.redirects.push(url);
      throw Object.assign(new Error(`REDIRECT:${url}`), { url });
    },
  };
}

async function postForm(POST, form) {
  const body = new FormData();
  for (const [key, value] of Object.entries(form)) body.set(key, value);
  try {
    await POST(new Request("https://relay.example/api/ops/voicemail/recover", {
      method: "POST",
      body,
    }));
  } catch (error) {
    if (!String(error?.message ?? "").startsWith("REDIRECT:")) throw error;
  }
}

async function runRecovery({ failLeadIds = new Set(), noWork = false } = {}) {
  const calls = {
    permissions: [],
    listTranscription: [],
    listSummary: [],
    transcriptions: [],
    accountAudits: [],
    platformAudits: [],
    redirects: [],
  };
  const account = {
    accountId: "acct-authoritative",
    accountSlug: "ryco-property-maintenance",
    businessName: "RYCO Property Maintenance",
    accountStatus: "active",
  };
  const { POST } = await loadTsModule("app/api/ops/voicemail/recover/route.ts", {
    "next/navigation": redirectRecorder(calls),
    "@/lib/auth": {
      requirePlatformOperatorAction: async (action) => {
        calls.permissions.push(action);
        return { userId: "ops-1", email: "ops@example.com", role: "operator" };
      },
    },
    "@/lib/ops-actions": opsActions,
    "@/lib/supabase": {
      getOpsAccountBySlug: async () => account,
      listLeadsNeedingTranscriptionRetry: async (...args) => {
        calls.listTranscription.push(args);
        return noWork
          ? []
          : [
              { id: "lead-transcript", account_id: account.accountId },
              { id: "lead-cross-tenant", account_id: "acct-other" },
            ];
      },
      listLeadsNeedingSummaryRetry: async (...args) => {
        calls.listSummary.push(args);
        return noWork
          ? []
          : [{ id: "lead-summary", account_id: account.accountId }];
      },
      recordAccountAuditEvents: async (input) => calls.accountAudits.push(input),
      recordPlatformAuditEvent: async (...args) => calls.platformAudits.push(args),
    },
    "@/lib/voicemail-ai": {
      transcribeLeadVoicemail: async (leadId, accountId, options) => {
        calls.transcriptions.push({ leadId, accountId, options });
        if (failLeadIds.has(leadId)) throw new Error(`failed ${leadId}`);
        return { status: "completed", transcript: "ok", summary: "ok" };
      },
    },
  });

  await postForm(POST, {
    account_slug: account.accountSlug,
    account_id: "acct-attacker",
  });
  return { calls, account };
}

test("operator recovery is account-scoped, audited, and quiet for the owner", async () => {
  const { calls, account } = await runRecovery();

  assert.deepEqual(calls.permissions, [opsActions.OPS_ACTIONS.voicemailRecovery]);
  assert.deepEqual(calls.listTranscription, [[10, account.accountId, true]]);
  assert.deepEqual(calls.listSummary, [[10, account.accountId]]);
  assert.deepEqual(calls.transcriptions, [
    { leadId: "lead-transcript", accountId: account.accountId, options: { notifyOwner: false } },
    { leadId: "lead-summary", accountId: account.accountId, options: { notifyOwner: false } },
  ]);
  assert.equal(calls.platformAudits.length, 2);
  assert.equal(calls.platformAudits[0][1]?.required, true);
  assert.equal(calls.accountAudits.length, 1);
  assert.match(calls.redirects.at(-1), /voicemail_recovery=recovered/);
  assert.match(calls.redirects.at(-1), /recovered=2/);
});

test("operator recovery reports a partial result without retrying another tenant", async () => {
  const { calls } = await runRecovery({ failLeadIds: new Set(["lead-summary"]) });

  assert.equal(calls.transcriptions.length, 2);
  assert.match(calls.redirects.at(-1), /voicemail_recovery=partial/);
  assert.match(calls.redirects.at(-1), /recovered=1/);
  assert.match(calls.redirects.at(-1), /failed=1/);
});

test("operator recovery makes no provider request when no work is eligible", async () => {
  const { calls } = await runRecovery({ noWork: true });

  assert.deepEqual(calls.transcriptions, []);
  assert.match(calls.redirects.at(-1), /voicemail_recovery=no_work/);
});
