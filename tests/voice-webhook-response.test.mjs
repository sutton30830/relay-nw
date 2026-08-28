import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { loadWebhookRoute } from "./helpers/webhook-modules.mjs";

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
    throw new Error(`Missing test mock for ${specifier}`);
  };
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

function makeHarness(callMode) {
  const account = {
    accountId: "acct-voice",
    accountSlug: "voice-test",
    businessName: "Voice Test",
    callMode,
    smsEnabled: true,
    twilioPhoneNumber: "+15551234567",
    ownerPhoneNumber: "+15557654321",
    dialTimeoutSeconds: 18,
    voicemailMaxSeconds: 60,
    missedCallVoiceName: "Polly.Joanna-Neural",
  };
  const afterCallbacks = [];
  const upserts = [];
  const missedCalls = [];
  const webhookEvents = [];
  const trialActivations = [];

  return {
    account,
    afterCallbacks,
    upserts,
    missedCalls,
    webhookEvents,
    trialActivations,
    mocks: {
      "next/server": { after: (callback) => afterCallbacks.push(callback) },
      "@/lib/env": {
        env: { allowUnsignedTwilioWebhooks: false, appBaseUrl: "https://relay.test" },
      },
      "@/lib/supabase": {
        assertTenantAccount: (value) => value,
        resolveAccountSafely: async (resolver) => resolver(),
        resolveAccountByCallSid: async () => ({
          status: "unresolved",
          reason: "call_sid_not_registered",
          lookupValue: null,
        }),
        resolveAccountByTwilioNumber: async () => ({ status: "resolved", account }),
        resolveConsistentAccountEvidence: (evidence) =>
          evidence.find((item) => item.resolution.status === "resolved").resolution,
        upsertCall: async (input) => upserts.push(input),
        logWebhookEvent: async (input) => webhookEvents.push(input),
      },
      "@/lib/twilio": {
        formDataToRecord: (formData) => Object.fromEntries(formData.entries()),
        logUnsignedTwilioWebhook: async () => {},
        rejectInvalidTwilioSignature: () => new Response("invalid", { status: 403 }),
        summarizeTwilioRequest: () => ({ requestUrl: "https://relay.test/api/twilio/voice" }),
        validateTwilioWebhook: () => ({
          shouldReject: false,
          wasAllowedByOverride: false,
          matchedUrl: "https://relay.test/api/twilio/voice",
          candidateUrls: [],
          hasSignature: true,
        }),
      },
      "@/lib/missed-call": {
        handleMissedCall: async (input) => {
          missedCalls.push(input);
          return { becameLive: true, smsStatus: "sent" };
        },
      },
      "@/lib/billing-activation": {
        activateStripeTrialForAccount: async (accountId) => trialActivations.push(accountId),
      },
      "@/lib/twilio/unresolved-account": {
        handleUnresolvedTwilioAccount: async () => new Response("unresolved", { status: 200 }),
      },
      "@/lib/twiml": {
        dialForwardTwiml: () => "<Response><Dial>owner</Dial></Response>",
        forwardedMissedCallTwiml: () => "<Response><Say>greeting</Say><Record /></Response>",
        twimlResponse: (xml) => new Response(xml, {
          status: 200,
          headers: { "content-type": "text/xml" },
        }),
      },
    },
  };
}

async function postVoice(route) {
  return route.POST(new Request("https://relay.test/api/twilio/voice", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      CallSid: "CA_voice_response_test",
      From: "+12065550123",
      To: "+15551234567",
    }),
  }));
}

test("forwarding voice webhook returns TwiML before missed-call pipeline work", async () => {
  const harness = makeHarness("forwarding");
  const route = await loadWebhookRoute(loadTsModule, "app/api/twilio/voice/route.ts", harness.mocks);

  const response = await postVoice(route);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /<Record/);
  assert.equal(harness.afterCallbacks.length, 1);
  assert.deepEqual(harness.upserts, []);
  assert.deepEqual(harness.missedCalls, []);
  assert.deepEqual(harness.webhookEvents, []);

  await harness.afterCallbacks[0]();
  assert.equal(harness.upserts.length, 1);
  assert.equal(harness.missedCalls.length, 1);
  assert.deepEqual(harness.trialActivations, [harness.account.accountId]);
  assert.equal(harness.webhookEvents.length, 1);
});

test("direct voice webhook returns dial TwiML before bookkeeping", async () => {
  const harness = makeHarness("direct");
  const route = await loadWebhookRoute(loadTsModule, "app/api/twilio/voice/route.ts", harness.mocks);

  const response = await postVoice(route);

  assert.equal(response.status, 200);
  assert.match(await response.text(), /<Dial>/);
  assert.equal(harness.afterCallbacks.length, 1);
  assert.deepEqual(harness.upserts, []);
  assert.deepEqual(harness.webhookEvents, []);

  await harness.afterCallbacks[0]();
  assert.equal(harness.upserts.length, 1);
  assert.equal(harness.webhookEvents.length, 1);
});
