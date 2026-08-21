import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadProfileRoute(mocks) {
  const source = await readFile(new URL("../app/api/ops/profile/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const require = (id) => {
    if (id in mocks) return mocks[id];
    throw new Error(`Missing mock: ${id}`);
  };
  const module = { exports: {} };
  new vm.Script(`(function(require,module,exports){${compiled}\n})`).runInThisContext()(require, module, module.exports);
  return module.exports;
}

function request(overrides = {}) {
  return new Request("https://relay.test/api/ops/profile", {
    method: "POST",
    body: new URLSearchParams({
      account_slug: "demo",
      legal_business_name: "Demo Plumbing LLC",
      business_name: "Demo Plumbing",
      owner_name: "Demo Owner",
      owner_email: "owner@example.com",
      owner_phone_number: "+12065550123",
      public_business_number: "+12065550124",
      call_mode: "forwarding",
      forwarding_carrier: "Verizon",
      business_hours_summary: "Mon-Fri 8-5",
      coverage_expectations: "Every missed call",
      sms_template: "Sorry we missed you. Reply STOP to opt out.",
      missed_call_voice_message: "Please leave a recorded message.",
      dial_timeout_seconds: "18",
      voicemail_max_seconds: "60",
      ...overrides,
    }),
  });
}

function fixture(previousOverrides = {}) {
  const calls = {
    settings: [],
    technical: [],
    messagingClears: [],
    notificationClears: [],
    approvalClears: [],
  };
  const previous = {
    callMode: "forwarding",
    publicBusinessNumber: "+12065550124",
    forwardingCarrier: "Verizon",
    smsTemplate: "Sorry we missed you. Reply STOP to opt out.",
    ownerEmail: "owner@example.com",
    ...previousOverrides,
  };
  const mocks = {
    "next/navigation": {
      redirect: (url) => {
        const error = new Error(`REDIRECT ${url}`);
        error.url = url;
        throw error;
      },
    },
    "@/lib/auth": {
      requirePlatformOperatorAction: async () => ({ userId: "ops-1", email: "ops@example.com" }),
    },
    "@/lib/ops-actions": { OPS_ACTIONS: { profileEdit: "profile.edit" } },
    "@/lib/phone": { normalizePhoneNumber: (value) => value },
    "@/lib/supabase": {
      getOpsAccountBySlug: async () => ({ accountId: "acct-selected" }),
      getAccountConfigByAccountId: async () => previous,
      updateAccountSettings: async (accountId, update) => calls.settings.push({ accountId, update }),
      updateAccountTechnicalSetupStatus: async (accountId, status) => calls.technical.push({ accountId, status }),
      clearMessagingOnboardingEvidence: async (accountId) => calls.messagingClears.push(accountId),
      clearOwnerNotificationEvidence: async (accountId) => calls.notificationClears.push(accountId),
      clearCustomerGoLiveApproval: async (accountId) => calls.approvalClears.push(accountId),
      recordAccountAuditEvents: async () => {},
      recordPlatformAuditEvent: async () => {},
    },
  };
  return { calls, mocks };
}

async function run(route, req) {
  await assert.rejects(route.POST(req), /REDIRECT/);
}

test("routing, SMS wording, and owner email changes invalidate superseded evidence", async () => {
  const f = fixture();
  const route = await loadProfileRoute(f.mocks);
  await run(route, request({
    public_business_number: "+12065550999",
    sms_template: "Updated wording. Reply STOP to opt out.",
    owner_email: "new-owner@example.com",
  }));

  assert.deepEqual(f.calls.technical, [{ accountId: "acct-selected", status: "waiting_for_forwarding" }]);
  assert.deepEqual(f.calls.messagingClears, ["acct-selected"]);
  assert.deepEqual(f.calls.notificationClears, ["acct-selected"]);
  assert.deepEqual(f.calls.approvalClears, []);
});

test("any other profile edit still clears customer go-live approval", async () => {
  const f = fixture();
  const route = await loadProfileRoute(f.mocks);
  await run(route, request({ business_name: "Demo Plumbing & Rooter" }));

  assert.deepEqual(f.calls.technical, []);
  assert.deepEqual(f.calls.messagingClears, []);
  assert.deepEqual(f.calls.notificationClears, []);
  assert.deepEqual(f.calls.approvalClears, ["acct-selected"]);
  assert.equal(f.calls.settings[0].accountId, "acct-selected");
  assert.deepEqual(f.calls.settings[0].update.business_hours, { summary: "Mon-Fri 8-5" });
  assert.equal(f.calls.settings[0].update.coverage_expectations, "Every missed call");
});

test("first-time routing details do not undo an already verified forwarding test", async () => {
  const f = fixture({ publicBusinessNumber: null, forwardingCarrier: null });
  const route = await loadProfileRoute(f.mocks);
  await run(route, request());

  assert.deepEqual(f.calls.technical, []);
});

test("changing carrier notes does not undo an already verified forwarding test", async () => {
  const f = fixture({ forwardingCarrier: "Unknown" });
  const route = await loadProfileRoute(f.mocks);
  await run(route, request({ forwarding_carrier: "Verizon" }));

  assert.deepEqual(f.calls.technical, []);
});
