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

function normalizePhoneNumber(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return digits ? `+${digits}` : "";
}

function formDataToRecord(formData) {
  return Object.fromEntries([...formData.entries()].map(([key, value]) => [key, String(value)]));
}

function resolveConsistentAccountEvidence(evidence) {
  const resolved = evidence.filter((item) => item.resolution.status === "resolved");
  const accountIds = new Set(resolved.map((item) => item.resolution.account.accountId));
  if (accountIds.size > 1) {
    return { status: "unresolved", reason: "provider_account_evidence_mismatch", lookupValue: null };
  }
  return resolved[0]?.resolution ?? evidence[0].resolution;
}

function makeMocks() {
  const calls = {
    clearOptOuts: [],
    recordOptOuts: [],
    inboundMessages: [],
    messages: [],
    ownerInboundReplies: [],
    ownerOptOuts: [],
    adminIssues: [],
    ownerForwards: [],
    webhookEvents: [],
  };

  const mocks = {
    "@/lib/env": {
      env: {
        allowUnsignedTwilioWebhooks: false,
        appBaseUrl: "http://localhost:3000",
      },
    },
    "@/lib/email": {
      notifyAdminOperationalIssue: async (input) => calls.adminIssues.push(input),
      notifyOwnerInboundReply: async (input) => calls.ownerInboundReplies.push(input),
      notifyOwnerOptOut: async (input) => calls.ownerOptOuts.push(input),
    },
    "@/lib/phone": { normalizePhoneNumber },
    "@/lib/supabase": {
      assertTenantAccount: (account) => account,
      clearOptOut: async (phone, accountId) => calls.clearOptOuts.push({ phone, accountId }),
      createInboundMessageIfNew: async (input) => {
        calls.inboundMessages.push(input);
        return { inserted: true };
      },
      createMessageIfNew: async (input) => {
        calls.messages.push(input);
        return { inserted: true };
      },
      logWebhookEvent: async (input) => calls.webhookEvents.push(input),
      recordOptOut: async (phone, accountId) => calls.recordOptOuts.push({ phone, accountId }),
      resolveAccountByMessageSid: async () => ({
        status: "unresolved",
        reason: "message_sid_not_registered",
        lookupValue: null,
      }),
      resolveAccountByTwilioNumber: async () => ({ status: "resolved", account: ACCOUNT }),
      resolveConsistentAccountEvidence,
      resolveAccountSafely: async (resolver) => resolver(),
    },
    "@/lib/twilio": {
      formDataToRecord,
      logUnsignedTwilioWebhook: async () => {},
      phoneLast4: (value) => String(value ?? "").slice(-4),
      rejectInvalidTwilioSignature: () => new Response("rejected", { status: 403 }),
      summarizeTwilioRequest: () => ({}),
      twilioClient: {
        messages: {
          create: async (input) => {
            calls.ownerForwards.push(input);
            return { sid: "SM_forwarded" };
          },
        },
      },
      validateTwilioWebhook: () => ({
        shouldReject: false,
        wasAllowedByOverride: false,
        matchedUrl: "http://localhost:3000/api/twilio/sms",
        candidateUrls: ["http://localhost:3000/api/twilio/sms"],
        hasSignature: true,
      }),
    },
    "@/lib/twilio/unresolved-account": {
      handleUnresolvedTwilioAccount: () => new Response("unresolved", { status: 200 }),
    },
    "@/lib/twiml": {
      emptyTwiml: () => `<?xml version="1.0" encoding="UTF-8"?>\n<Response></Response>`,
      helpReplyTwiml: ({ businessName }) =>
        `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Message>${businessName} via Relay NW: we text you back when we miss your call. Msg&amp;data rates may apply. Msg frequency varies. Reply STOP to opt out.</Message>\n</Response>`,
      twimlResponse: (body) =>
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/xml; charset=utf-8" },
        }),
    },
  };

  return { mocks, calls };
}

async function postInboundSms(body, overrides = {}) {
  const { mocks, calls } = makeMocks();
  const { POST } = await loadTsModule("app/api/twilio/sms/route.ts", mocks);
  const payload = new URLSearchParams({
    MessageSid: overrides.messageSid ?? "SM_inbound_1",
    From: overrides.from ?? "(206) 555-0123",
    To: overrides.to ?? "+14253689655",
    Body: body,
  });

  const response = await POST(new Request("http://localhost:3000/api/twilio/sms", {
    method: "POST",
    body: payload,
  }));

  return { response, responseBody: await response.text(), calls };
}

test("START from an opted-out caller clears the opt-out row", async () => {
  const { calls } = await postInboundSms("START");

  assert.deepEqual(calls.clearOptOuts, [{ phone: "+12065550123", accountId: "acct-1" }]);
  assert.deepEqual(calls.recordOptOuts, []);
  assert.match(calls.webhookEvents[0].error, /Recorded re-opt-in \(START\)/);
});

test("STOPALL records an opt-out exactly like STOP", async () => {
  const { calls } = await postInboundSms("STOPALL");

  assert.deepEqual(calls.recordOptOuts, [{ phone: "+12065550123", accountId: "acct-1" }]);
  assert.equal(calls.ownerOptOuts.length, 1);
  assert.match(calls.webhookEvents[0].error, /Recorded opt-out/);
});

test("HELP returns TwiML with the business name and STOP language", async () => {
  const { response, responseBody, calls } = await postInboundSms("HELP");

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/xml/);
  assert.match(responseBody, /Demo Plumbing/);
  assert.match(responseBody, /STOP/);
  assert.match(responseBody, /Msg&amp;data rates may apply/);
  assert.deepEqual(calls.ownerInboundReplies, []);
  assert.deepEqual(calls.ownerForwards, []);
  assert.match(calls.webhookEvents[0].error, /Answered HELP with business info/);
});

test("START does not notify or forward to the owner", async () => {
  const { calls } = await postInboundSms("UNSTOP");

  assert.equal(calls.clearOptOuts.length, 1);
  assert.deepEqual(calls.ownerInboundReplies, []);
  assert.deepEqual(calls.ownerForwards, []);
  assert.deepEqual(calls.ownerOptOuts, []);
});

test("a plain conversational reply still forwards and does not touch opt-outs", async () => {
  const { calls } = await postInboundSms("Can you call me back?");

  assert.deepEqual(calls.clearOptOuts, []);
  assert.deepEqual(calls.recordOptOuts, []);
  assert.equal(calls.ownerInboundReplies.length, 1);
  assert.equal(calls.ownerForwards.length, 1);
  assert.match(calls.webhookEvents[0].error, /Forwarded inbound reply to owner/);
});
