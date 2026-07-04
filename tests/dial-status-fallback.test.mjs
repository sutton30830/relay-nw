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

const CALL_SID_UNRESOLVED = {
  status: "unresolved",
  reason: "call_sid_not_registered",
  lookupValue: "CA_missing",
};

const NUMBER_UNRESOLVED = {
  status: "unresolved",
  reason: "twilio_number_not_registered",
  lookupValue: "+19995550123",
};

function formDataToRecord(formData) {
  return Object.fromEntries([...formData.entries()].map(([key, value]) => [key, String(value)]));
}

function makeMocks({
  callSidResolution = { status: "resolved", account: ACCOUNT },
  numberResolution = { status: "resolved", account: ACCOUNT },
} = {}) {
  const calls = {
    callSidLookups: [],
    numberLookups: [],
    missedCalls: [],
    unresolved: [],
    upsertCalls: [],
    webhookEvents: [],
  };

  const mocks = {
    "@/lib/env": {
      env: {
        allowUnsignedTwilioWebhooks: false,
      },
    },
    "@/lib/missed-call": {
      handleMissedCall: async (input) => {
        calls.missedCalls.push(input);
        return { smsStatus: "sent" };
      },
    },
    "@/lib/supabase": {
      assertTenantAccount: (account) => account,
      logWebhookEvent: async (input) => calls.webhookEvents.push(input),
      resolveAccountByCallSid: async (callSid) => {
        calls.callSidLookups.push(callSid);
        return callSidResolution;
      },
      resolveAccountByTwilioNumber: async (phoneNumber) => {
        calls.numberLookups.push(phoneNumber);
        return numberResolution;
      },
      resolveAccountSafely: async (resolver) => resolver(),
      upsertCall: async (input) => calls.upsertCalls.push(input),
    },
    "@/lib/twilio": {
      formDataToRecord,
      logUnsignedTwilioWebhook: async () => {},
      phoneLast4: (value) => String(value ?? "").replace(/\D/g, "").slice(-4),
      rejectInvalidTwilioSignature: () => new Response("invalid", { status: 403 }),
      summarizeTwilioRequest: () => ({ requestUrl: "https://example.com/api/twilio/dial-status" }),
      validateTwilioWebhook: () => ({
        shouldReject: false,
        wasAllowedByOverride: false,
        matchedUrl: "https://example.com/api/twilio/dial-status",
        candidateUrls: [],
        hasSignature: true,
      }),
    },
    "@/lib/twilio/unresolved-account": {
      handleUnresolvedTwilioAccount: async (input) => {
        calls.unresolved.push(input);
        return new Response(input.responseBody ?? "<Response/>", { status: 200 });
      },
    },
    "@/lib/twiml": {
      emptyTwiml: () => "<Response/>",
      twimlResponse: (xml) => new Response(xml, { status: 200 }),
    },
  };

  return { mocks, calls };
}

async function postDialStatus(mocks, payload = {}) {
  const { POST } = await loadTsModule("app/api/twilio/dial-status/route.ts", mocks);
  const body = new URLSearchParams({
    CallSid: "CA_missing",
    From: "+12065550123",
    To: "+14253689655",
    DialCallStatus: "no-answer",
    ...payload,
  });

  return POST(new Request("https://example.com/api/twilio/dial-status", {
    method: "POST",
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }));
}

test("unknown CallSid with a registered To number resolves and texts the caller", async () => {
  const { mocks, calls } = makeMocks({
    callSidResolution: CALL_SID_UNRESOLVED,
    numberResolution: { status: "resolved", account: ACCOUNT },
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);

  try {
    const response = await postDialStatus(mocks);

    assert.equal(response.status, 200);
    assert.deepEqual(calls.callSidLookups, ["CA_missing"]);
    assert.deepEqual(calls.numberLookups, ["+14253689655"]);
    assert.equal(calls.unresolved.length, 0);
    assert.equal(calls.missedCalls.length, 1);
    assert.equal(calls.missedCalls[0].account, ACCOUNT);
    assert.equal(calls.missedCalls[0].callerPhone, "+12065550123");
    assert.equal(calls.missedCalls[0].callSid, "CA_missing");
    assert.equal(calls.upsertCalls.length, 1);
    assert.equal(calls.upsertCalls[0].accountId, "acct-1");
    assert.ok(warnings.some(([message]) => String(message).includes("dial-status resolved by To-number fallback")));
  } finally {
    console.warn = originalWarn;
  }
});

test("known CallSid never consults the To-number fallback", async () => {
  const { mocks, calls } = makeMocks({
    callSidResolution: { status: "resolved", account: ACCOUNT },
    numberResolution: NUMBER_UNRESOLVED,
  });

  const response = await postDialStatus(mocks);

  assert.equal(response.status, 200);
  assert.deepEqual(calls.callSidLookups, ["CA_missing"]);
  assert.deepEqual(calls.numberLookups, []);
  assert.equal(calls.unresolved.length, 0);
  assert.equal(calls.missedCalls.length, 1);
});

test("unknown CallSid and unregistered To number stays unresolved with the CallSid reason", async () => {
  const { mocks, calls } = makeMocks({
    callSidResolution: CALL_SID_UNRESOLVED,
    numberResolution: NUMBER_UNRESOLVED,
  });

  const response = await postDialStatus(mocks);

  assert.equal(response.status, 200);
  assert.deepEqual(calls.callSidLookups, ["CA_missing"]);
  assert.deepEqual(calls.numberLookups, ["+14253689655"]);
  assert.equal(calls.missedCalls.length, 0);
  assert.equal(calls.upsertCalls.length, 0);
  assert.equal(calls.unresolved.length, 1);
  assert.equal(calls.unresolved[0].resolution.reason, "call_sid_not_registered");
});
