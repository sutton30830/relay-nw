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

const billingPolicy = await loadTsModule("lib/billing.ts", {
  "@/lib/readiness": {},
  "@/lib/customer-experience-contract": {
    canStartMonthlyBilling: (status) => status === "live",
  },
});

function trialAccount(overrides = {}) {
  return {
    accountId: "acct-trial",
    accountSlug: "trial-plumbing",
    businessName: "Trial Plumbing",
    ownerEmail: "owner@example.com",
    billingStatus: "trialing",
    stripeSubscriptionId: null,
    trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function runtimeAccount(accountId = "acct-trial") {
  return {
    accountId,
    accountSlug: "trial-plumbing",
    businessName: "Trial Plumbing",
    ownerEmail: "owner@example.com",
    callMode: "forwarding",
    smsEnabled: true,
    intakeUrl: "https://www.relay-nw.com/intake",
    schedulingUrl: "",
    smsTemplate: null,
    quickReplyTemplates: null,
    missedCallVoiceMessage: null,
    missedCallVoiceName: "Polly.Joanna-Neural",
    missedCallGreetingAudioUrl: null,
    voicemailMaxSeconds: 60,
    dialTimeoutSeconds: 18,
    missedCallSmsCooldownHours: 24,
    typicalJobValueCents: null,
    voicemailTranscriptionEnabled: true,
    twilioPhoneNumber: "+15551234567",
    ownerPhoneNumber: "+12065550123",
  };
}

async function runCron({
  cronSecret = "secret",
  accounts = [trialAccount()],
  completed = new Set(),
  failAccountIds = new Set(),
} = {}) {
  const calls = {
    ownerTrialExpired: [],
    adminAlerts: [],
    updates: [],
    audits: [],
    configLookups: [],
    listedAt: [],
  };

  const { GET } = await loadTsModule("app/api/cron/billing-trials/route.ts", {
    "@/lib/env": {
      env: { cronSecret },
    },
    "@/lib/email": {
      notifyOwnerBillingTrialExpired: async (input) => {
        calls.ownerTrialExpired.push(input);
        if (failAccountIds.has(input.account.accountId)) throw new Error("owner email failed");
        return { sent: true };
      },
      notifyAdminOperationalIssue: async (input) => {
        calls.adminAlerts.push(input);
        return { sent: true };
      },
    },
    "@/lib/billing": billingPolicy,
    "@/lib/supabase": {
      listAccountsForBillingTrialExpiry: async (nowIso) => {
        calls.listedAt.push(nowIso);
        return accounts;
      },
      hasAccountAuditAction: async (_accountId, action) => completed.has(action),
      getAccountConfigByAccountId: async (accountId) => {
        calls.configLookups.push(accountId);
        return runtimeAccount(accountId);
      },
      updateAccountBillingRecord: async (accountId, update) => calls.updates.push({ accountId, update }),
      recordAccountAuditEvents: async (input) => calls.audits.push(input),
    },
  });

  const response = await GET(new Request("https://example.com/api/cron/billing-trials", {
    headers: { authorization: "Bearer secret" },
  }));

  return { response, body: await response.json(), calls };
}

test("billing trial cron rejects missing or wrong CRON_SECRET", async () => {
  const missing = await runCron({ cronSecret: "" });
  assert.equal(missing.response.status, 503);

  const { GET } = await loadTsModule("app/api/cron/billing-trials/route.ts", {
    "@/lib/env": { env: { cronSecret: "secret" } },
    "@/lib/email": {},
    "@/lib/billing": billingPolicy,
    "@/lib/supabase": {},
  });
  const wrong = await GET(new Request("https://example.com/api/cron/billing-trials", {
    headers: { authorization: "Bearer nope" },
  }));
  assert.equal(wrong.status, 401);
});

test("expired app-level trial flips once to billing attention and notifies owner plus operator", async () => {
  const { response, body, calls } = await runCron();

  assert.equal(response.status, 200);
  assert.equal(body.changed, 1);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].accountId, "acct-trial");
  assert.deepEqual(calls.updates[0].update, {
    billingStatus: "past_due",
    billingAttentionSince: calls.updates[0].update.billingAttentionSince,
    cancelAtPeriodEnd: false,
  });
  assert.match(calls.updates[0].update.billingAttentionSince, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls.ownerTrialExpired.length, 1);
  assert.equal(calls.adminAlerts.length, 1);
  assert.equal(calls.audits[0].events[0].action, billingPolicy.BILLING_TRIAL_EXPIRY_ACTION);
  assert.match(calls.audits[0].events[0].summary, /Call capture remains on/);
});

test("completed trial expiry audit prevents repeat expiration work", async () => {
  const { body, calls } = await runCron({
    completed: new Set([billingPolicy.BILLING_TRIAL_EXPIRY_ACTION]),
  });

  assert.equal(body.changed, 0);
  assert.equal(calls.updates.length, 0);
  assert.equal(calls.ownerTrialExpired.length, 0);
});

test("Stripe-backed trials are ignored by app-level trial expiry", async () => {
  const { body, calls } = await runCron({
    accounts: [trialAccount({ stripeSubscriptionId: "sub_123" })],
  });

  assert.equal(body.changed, 0);
  assert.equal(calls.updates.length, 0);
});

test("billing trial cron continues when one account fails", async () => {
  const failing = trialAccount({ accountId: "acct-fail", accountSlug: "fail" });
  const passing = trialAccount({ accountId: "acct-pass", accountSlug: "pass" });
  const { body, calls } = await runCron({
    accounts: [failing, passing],
    failAccountIds: new Set(["acct-fail"]),
  });

  assert.equal(body.failed, 1);
  assert.equal(calls.updates.length, 2);
  assert.equal(calls.ownerTrialExpired.length, 2);
  assert.equal(calls.audits.length, 1);
});
