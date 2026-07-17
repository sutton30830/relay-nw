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

const policy = await loadTsModule("lib/onboarding-deadlines.ts", {
  "@/lib/billing": {},
});

function account(overrides = {}) {
  return {
    accountId: "acct-1",
    accountSlug: "demo",
    businessName: "Demo Plumbing",
    ownerEmail: "owner@example.com",
    onboardingStatus: "waiting_on_customer",
    requirementsDueAt: "2026-08-15T00:00:00.000Z",
    onboardingStatusUpdatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

async function runCron({
  cronSecret = "secret",
  accounts = [account()],
  completed = new Set(),
  failAccountIds = new Set(),
} = {}) {
  const calls = {
    reminders: [],
    pausedEmails: [],
    adminAlerts: [],
    updates: [],
    audits: [],
    configLookups: [],
  };

  const { GET } = await loadTsModule("app/api/cron/onboarding-deadlines/route.ts", {
    "@/lib/env": {
      env: { cronSecret },
    },
    "@/lib/email": {
      notifyOwnerOnboardingRequirementsReminder: async (input) => {
        calls.reminders.push(input);
        if (failAccountIds.has(input.account.accountId)) throw new Error("owner email failed");
        return { sent: true };
      },
      notifyOwnerOnboardingPaused: async (input) => {
        calls.pausedEmails.push(input);
        return { sent: true };
      },
      notifyAdminOperationalIssue: async (input) => {
        calls.adminAlerts.push(input);
        return { sent: true };
      },
    },
    "@/lib/onboarding-deadlines": policy,
    "@/lib/supabase": {
      listAccountsForOnboardingDeadlineMaintenance: async () => accounts,
      hasAccountAuditAction: async (_accountId, action) => completed.has(action),
      getAccountConfigByAccountId: async (accountId) => {
        calls.configLookups.push(accountId);
        return {
          accountId,
          accountSlug: "demo",
          businessName: "Demo Plumbing",
          ownerEmail: "owner@example.com",
          callMode: "forwarding",
          smsEnabled: false,
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
          voicemailTranscriptionEnabled: true,
          twilioPhoneNumber: "+15551234567",
          ownerPhoneNumber: "+12065550123",
        };
      },
      updateAccountBillingRecord: async (accountId, update) => calls.updates.push({ accountId, update }),
      recordAccountAuditEvents: async (input) => calls.audits.push(input),
    },
  });

  const response = await GET(new Request("https://example.com/api/cron/onboarding-deadlines", {
    headers: { authorization: "Bearer secret" },
  }));

  return { response, body: await response.json(), calls };
}

test("requirements due date defaults to 14 days out", () => {
  assert.equal(
    policy.defaultRequirementsDueAt(new Date("2026-08-01T00:00:00.000Z")),
    "2026-08-15T00:00:00.000Z",
  );
});

test("owner delay message is only shown while waiting on customer requirements", () => {
  assert.match(
    policy.ownerOnboardingDelayMessage({
      onboardingStatus: "waiting_on_customer",
      requirementsDueAt: "2026-08-15T00:00:00.000Z",
    }),
    /Complete it by August 15/,
  );
  assert.equal(
    policy.ownerOnboardingDelayMessage({
      onboardingStatus: "carrier_review",
      requirementsDueAt: "2026-08-15T00:00:00.000Z",
    }),
    null,
  );
});

test("deadline policy sends day-3 and day-7 reminders before pausing and closing", () => {
  const due = "2026-08-15T00:00:00.000Z";

  assert.equal(policy.chooseOnboardingDeadlineAction({
    onboardingStatus: "waiting_on_customer",
    requirementsDueAt: due,
    now: new Date("2026-08-04T00:00:00.000Z"),
  }), "remind_day_3");
  assert.equal(policy.chooseOnboardingDeadlineAction({
    onboardingStatus: "waiting_on_customer",
    requirementsDueAt: due,
    now: new Date("2026-08-08T00:00:00.000Z"),
  }), "remind_day_7");
  assert.equal(policy.chooseOnboardingDeadlineAction({
    onboardingStatus: "waiting_on_customer",
    requirementsDueAt: due,
    now: new Date("2026-08-15T00:00:00.000Z"),
  }), "pause_incomplete");
  assert.equal(policy.chooseOnboardingDeadlineAction({
    onboardingStatus: "paused_incomplete",
    requirementsDueAt: due,
    now: new Date("2026-08-31T00:00:00.000Z"),
  }), "close_incomplete");
});

test("deadline policy never skips directly from waiting to closed", () => {
  assert.equal(policy.chooseOnboardingDeadlineAction({
    onboardingStatus: "waiting_on_customer",
    requirementsDueAt: "2026-08-15T00:00:00.000Z",
    now: new Date("2026-09-15T00:00:00.000Z"),
  }), "pause_incomplete");
});

test("deadline policy is idempotent using completed audit actions", () => {
  const completedActions = new Set([policy.ONBOARDING_DEADLINE_ACTIONS.remind_day_7]);

  assert.equal(policy.chooseOnboardingDeadlineAction({
    onboardingStatus: "waiting_on_customer",
    requirementsDueAt: "2026-08-15T00:00:00.000Z",
    completedActions,
    now: new Date("2026-08-08T00:00:00.000Z"),
  }), "none");
});

test("carrier-caused delay statuses are ignored by customer-deadline policy", () => {
  for (const onboardingStatus of ["carrier_review", "carrier_attention", "ready_to_activate", "activated"]) {
    assert.equal(policy.chooseOnboardingDeadlineAction({
      onboardingStatus,
      requirementsDueAt: "2026-08-15T00:00:00.000Z",
      now: new Date("2026-09-01T00:00:00.000Z"),
    }), "none");
  }
});

test("onboarding deadline cron rejects missing or wrong CRON_SECRET", async () => {
  const missing = await runCron({ cronSecret: "" });
  assert.equal(missing.response.status, 503);

  const { GET } = await loadTsModule("app/api/cron/onboarding-deadlines/route.ts", {
    "@/lib/env": { env: { cronSecret: "secret" } },
    "@/lib/email": {},
    "@/lib/onboarding-deadlines": policy,
    "@/lib/supabase": {},
  });
  const wrong = await GET(new Request("https://example.com/api/cron/onboarding-deadlines", {
    headers: { authorization: "Bearer nope" },
  }));
  assert.equal(wrong.status, 401);
});

test("onboarding deadline cron sends reminders and records audit markers", async () => {
  const { response, body, calls } = await runCron({
    accounts: [account({ requirementsDueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() })],
  });

  assert.equal(response.status, 200);
  assert.equal(body.changed, 1);
  assert.equal(calls.reminders.length, 1);
  assert.equal(calls.adminAlerts.length, 1);
  assert.equal(calls.audits[0].events[0].action, policy.ONBOARDING_DEADLINE_ACTIONS.remind_day_7);
});

test("onboarding deadline cron pauses and closes incomplete onboarding", async () => {
  const pause = await runCron({
    accounts: [account({ requirementsDueAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() })],
  });
  assert.equal(pause.body.changed, 1);
  assert.deepEqual(pause.calls.updates[0].update, { onboardingStatus: "paused_incomplete" });
  assert.equal(pause.calls.pausedEmails.length, 1);

  const close = await runCron({
    accounts: [account({
      onboardingStatus: "paused_incomplete",
      requirementsDueAt: new Date(Date.now() - 17 * 24 * 60 * 60 * 1000).toISOString(),
    })],
  });
  assert.equal(close.body.changed, 1);
  assert.deepEqual(close.calls.updates[0].update, { onboardingStatus: "closed_incomplete" });
});

test("onboarding deadline cron continues when one account fails", async () => {
  const failing = account({
    accountId: "acct-fail",
    accountSlug: "fail",
    requirementsDueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const passing = account({
    accountId: "acct-pass",
    accountSlug: "pass",
    requirementsDueAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const { body, calls } = await runCron({
    accounts: [failing, passing],
    failAccountIds: new Set(["acct-fail"]),
  });

  assert.equal(body.failed, 1);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].accountId, "acct-pass");
});
