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

const ACCOUNT = {
  accountId: "acct-1",
  accountSlug: "demo",
  businessName: "Demo Plumbing",
  smsEnabled: true,
  twilioPhoneNumber: "+14253689655",
  ownerPhoneNumber: "+12065550000",
  ownerEmail: "owner@example.com",
};

function makeMocks({
  resendApiKey = "re_test",
  adminAlertEmail = "admin@example.com",
  sendBehavior = async () => ({ data: { id: "em_123" }, error: null }),
  captureBehavior = () => {},
  ownerLookupEmail = null,
} = {}) {
  const calls = {
    resendSends: [],
    sentryMessages: [],
  };

  class MockResend {
    constructor(apiKey) {
      this.apiKey = apiKey;
      this.emails = {
        send: async (input) => {
          calls.resendSends.push({ apiKey: this.apiKey, input });
          return sendBehavior(input);
        },
      };
    }
  }

  return {
    calls,
    mocks: {
      "@sentry/nextjs": {
        captureMessage: (message, context) => {
          calls.sentryMessages.push({ message, context });
          return captureBehavior(message, context);
        },
      },
      "resend": { Resend: MockResend },
      "@/lib/env": {
        env: {
          resendApiKey,
          adminAlertEmail,
          alertFromEmail: "alerts@example.com",
          appBaseUrl: "https://relay-nw.com",
        },
      },
      "@/lib/supabase": {
        getOwnerNotificationEmail: async () => ownerLookupEmail,
      },
    },
  };
}

test("a Resend API error captures a Sentry message tagged with the email tag", async () => {
  const { mocks, calls } = makeMocks({
    sendBehavior: async () => ({ data: null, error: { message: "quota exceeded" } }),
  });
  const { notifyAdminOperationalIssue } = await loadTsModule("lib/email.ts", mocks);

  const result = await notifyAdminOperationalIssue({ account: ACCOUNT, issue: "SMS failed" });

  assert.equal(result.sent, false);
  assert.equal(calls.sentryMessages.length, 1);
  assert.equal(calls.sentryMessages[0].message, "Email alert delivery failed");
  assert.equal(calls.sentryMessages[0].context.level, "error");
  assert.deepEqual(calls.sentryMessages[0].context.tags, { tag: "admin_operational_issue" });
  assert.match(calls.sentryMessages[0].context.extra.subject, /Relay NW alert/);
  assert.match(calls.sentryMessages[0].context.extra.error, /quota exceeded/);
});

test("a thrown Resend exception captures a Sentry message", async () => {
  const { mocks, calls } = makeMocks({
    sendBehavior: async () => {
      throw new Error("resend unavailable");
    },
  });
  const { notifyAdminOperationalIssue } = await loadTsModule("lib/email.ts", mocks);

  const result = await notifyAdminOperationalIssue({ account: ACCOUNT, issue: "Webhook unresolved" });

  assert.equal(result.sent, false);
  assert.equal(calls.sentryMessages.length, 1);
  assert.equal(calls.sentryMessages[0].message, "Email alert delivery failed");
  assert.equal(calls.sentryMessages[0].context.level, "error");
  assert.deepEqual(calls.sentryMessages[0].context.tags, { tag: "admin_operational_issue" });
  assert.match(calls.sentryMessages[0].context.extra.error, /resend unavailable/);
});

test("a skipped admin_operational_issue alert captures a Sentry warning", async () => {
  const { mocks, calls } = makeMocks({ resendApiKey: "", adminAlertEmail: "admin@example.com" });
  const { notifyAdminOperationalIssue } = await loadTsModule("lib/email.ts", mocks);

  const result = await notifyAdminOperationalIssue({ account: ACCOUNT, issue: "Supabase down" });

  assert.deepEqual(result, { sent: false, skipped: true });
  assert.equal(calls.resendSends.length, 0);
  assert.equal(calls.sentryMessages.length, 1);
  assert.equal(calls.sentryMessages[0].message, "Admin alert skipped: email backstop not configured");
  assert.equal(calls.sentryMessages[0].context.level, "warning");
  assert.deepEqual(calls.sentryMessages[0].context.tags, { tag: "admin_operational_issue" });
  assert.deepEqual(calls.sentryMessages[0].context.extra, {
    hasResendApiKey: false,
    hasRecipient: true,
  });
});

test("a successful send captures nothing", async () => {
  const { mocks, calls } = makeMocks();
  const { notifyAdminOperationalIssue } = await loadTsModule("lib/email.ts", mocks);

  const result = await notifyAdminOperationalIssue({ account: ACCOUNT, issue: "Recovered" });

  assert.equal(result.sent, true);
  assert.equal(calls.resendSends.length, 1);
  assert.deepEqual(calls.sentryMessages, []);
});

test("a skipped owner notification captures nothing", async () => {
  const { mocks, calls } = makeMocks({
    resendApiKey: "",
    ownerLookupEmail: null,
  });
  const { notifyOwnerNewMissedCallLead } = await loadTsModule("lib/email.ts", mocks);

  const result = await notifyOwnerNewMissedCallLead({
    account: { ...ACCOUNT, ownerEmail: null },
    leadId: "lead-1",
    callerPhone: "+12065550123",
    smsStatus: "sent",
  });

  assert.deepEqual(result, { sent: false, skipped: true });
  assert.equal(calls.resendSends.length, 0);
  assert.deepEqual(calls.sentryMessages, []);
});

test("owner missed-call email preference skips delivery before provider lookup", async () => {
  const { mocks, calls } = makeMocks();
  const { notifyOwnerNewMissedCallLead } = await loadTsModule("lib/email.ts", mocks);

  const result = await notifyOwnerNewMissedCallLead({
    account: {
      ...ACCOUNT,
      notificationPreferences: {
        missedCall: { email: false, sms: true },
        voicemailReady: { email: true, sms: false },
        inboundReply: { email: true, sms: true },
        urgentVoicemailSms: true,
      },
    },
    leadId: "lead-pref-off",
    callerPhone: "+12065550123",
    smsStatus: "sent",
  });

  assert.deepEqual(result, { sent: false, skipped: true });
  assert.deepEqual(calls.resendSends, []);
  assert.deepEqual(calls.sentryMessages, []);
});

test("a Sentry failure never throws out of sendEmail", async () => {
  const { mocks, calls } = makeMocks({
    sendBehavior: async () => ({ data: null, error: { message: "bad domain" } }),
    captureBehavior: () => {
      throw new Error("sentry unavailable");
    },
  });
  const { notifyAdminOperationalIssue } = await loadTsModule("lib/email.ts", mocks);

  const result = await notifyAdminOperationalIssue({ account: ACCOUNT, issue: "Email broken" });

  assert.equal(result.sent, false);
  assert.equal(result.skipped, false);
  assert.equal(calls.sentryMessages.length, 1);
});
