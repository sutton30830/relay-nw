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
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

const types = await loadTsModule("lib/telephony/types.ts");
const contract = await loadTsModule("lib/telephony/provider.ts");

test("Relay contract exposes every required canonical event and voice instruction", () => {
  assert.deepEqual([...types.TELEPHONY_EVENT_TYPES], [
    "inbound_call",
    "call_completed",
    "recording_ready",
    "inbound_message",
    "message_delivery_updated",
  ]);
  assert.deepEqual([...contract.RELAY_VOICE_INSTRUCTION_TYPES], [
    "forward_to_owner",
    "play_greeting",
    "capture_voicemail",
    "reject_safely",
  ]);
  assert.deepEqual([...contract.TELEPHONY_CAPABILITY_KEYS], [
    "outboundSms",
    "messageDeliveryUpdates",
    "recordingAudio",
    "resourceDeletion",
    "numberSearch",
    "numberConfiguration",
    "numberRelease",
    "messagingRegistrationEvidence",
    "signedWebhooks",
    "voiceInstructions",
  ]);
});

test("provider identifiers normalize provider keys while preserving opaque values", () => {
  const messageId = types.providerIdentifier({
    provider: "  TWILIO  ",
    kind: "message",
    value: "  any-provider-opaque-value  ",
  });

  assert.deepEqual(messageId, {
    provider: "twilio",
    kind: "message",
    value: "any-provider-opaque-value",
  });
  assert.equal(types.sameProviderIdentifier(messageId, { ...messageId }), true);
  assert.equal(types.sameProviderIdentifier(messageId, { ...messageId, kind: "call" }), false);
  assert.throws(
    () => types.providerIdentifier({ provider: "twilio", kind: "call", value: "  " }),
    /non-empty value/,
  );
  assert.throws(
    () => types.providerIdentifier({ provider: "not valid", kind: "call", value: "id" }),
    /lowercase provider key/,
  );
});

test("provider registry defaults to Twilio and fails closed for unknown providers", async () => {
  const fakeTwilio = { identity: { id: "twilio", displayName: "Twilio" } };
  const registryModule = await loadTsModule("lib/telephony/registry.ts", {
    "@/lib/telephony/providers/twilio": { twilioProvider: fakeTwilio },
  });

  assert.equal(registryModule.DEFAULT_TELEPHONY_PROVIDER_ID, "twilio");
  assert.equal(registryModule.getTelephonyProvider(), fakeTwilio);
  assert.deepEqual(registryModule.telephonyProviders.list(), [fakeTwilio]);
  assert.throws(() => registryModule.getTelephonyProvider("missing"), /Unknown telephony provider/);
  assert.throws(
    () => registryModule.createTelephonyProviderRegistry({ providers: [], defaultProviderId: "twilio" }),
    /Default telephony provider is not registered/,
  );
});

function adapterHarness() {
  const sent = [];
  const validated = [];
  const client = {
    messages: Object.assign(() => ({ remove: async () => true }), {
      create: async (input) => {
        sent.push(input);
        return { sid: "not-a-sid-shaped-id", status: "queued" };
      },
    }),
    recordings: () => ({ remove: async () => true }),
    availablePhoneNumbers: () => ({ local: { list: async () => [] } }),
    incomingPhoneNumbers: Object.assign(
      () => ({ update: async () => ({}), remove: async () => true }),
      { list: async () => [] },
    ),
  };
  class VoiceResponse {
    dial() { return { number() {} }; }
    say() {}
    play() {}
    record() {}
    hangup() {}
    toString() { return "<Response />"; }
  }
  const twilioMock = Object.assign(() => client, {
    validateRequest: (_token, signature, url) => {
      validated.push(url);
      return signature === "valid" && url.endsWith("/canonical");
    },
    twiml: { VoiceResponse },
  });

  return {
    sent,
    validated,
    client,
    mocks: {
      twilio: twilioMock,
      "@/lib/env": {
        env: { twilioAccountSid: "AC_test", twilioAuthToken: "auth_test" },
      },
      "@/lib/telephony/types": types,
      "@/lib/telephony/provider": contract,
    },
  };
}

test("Twilio adapter reports Relay-required capabilities and Relay-owned idempotency", async () => {
  const harness = adapterHarness();
  const adapter = await loadTsModule("lib/telephony/providers/twilio.ts", harness.mocks);

  assert.deepEqual(adapter.twilioProvider.identity, { id: "twilio", displayName: "Twilio" });
  for (const capability of contract.TELEPHONY_CAPABILITY_KEYS) {
    assert.equal(adapter.twilioProvider.capabilities[capability], "supported");
  }
  assert.equal(adapter.twilioProvider.capabilities.smsIdempotency, "relay_reservation");

  const result = await adapter.twilioProvider.sendSms({
    from: "+12065550100",
    to: "+12065550123",
    body: "Hello",
    idempotencyKey: "manual_reply:lead-1:key-1",
    deliveryCallback: {
      url: "https://relay.example/api/twilio/sms-status?existing=kept",
      metadata: { accountId: "acct-1", actionKey: "manual_reply:lead-1:key-1" },
    },
  });

  assert.equal(result.idempotencyKey, "manual_reply:lead-1:key-1");
  assert.deepEqual(result.messageId, {
    provider: "twilio",
    kind: "message",
    value: "not-a-sid-shaped-id",
  });
  const callback = new URL(harness.sent[0].statusCallback);
  assert.equal(callback.searchParams.get("existing"), "kept");
  assert.equal(callback.searchParams.get("accountId"), "acct-1");
  assert.equal(callback.searchParams.get("actionKey"), "manual_reply:lead-1:key-1");
  await assert.rejects(
    () => adapter.twilioProvider.sendSms({
      from: "+12065550100",
      to: "+12065550123",
      body: "Hello",
      idempotencyKey: " ",
      deliveryCallback: null,
    }),
    /non-empty SMS idempotency key/,
  );
  assert.equal(harness.sent.length, 1);

  assert.equal(await adapter.twilioProvider.deleteResource({
    provider: "twilio",
    kind: "message",
    value: "message-to-delete",
  }), "deleted");
});

test("Twilio adapter verifies signatures fail-closed and emits provider-neutral events", async () => {
  const harness = adapterHarness();
  const { twilioProvider } = await loadTsModule(
    "lib/telephony/providers/twilio.ts",
    harness.mocks,
  );

  assert.deepEqual(twilioProvider.verifyWebhookSignature({
    candidateUrls: ["https://relay.example/request", "https://relay.example/canonical"],
    headers: {},
    form: {},
  }), { isValid: false, matchedUrl: null, hasSignature: false });
  assert.deepEqual(twilioProvider.verifyWebhookSignature({
    candidateUrls: ["https://relay.example/request", "https://relay.example/canonical"],
    headers: { "X-Twilio-Signature": "valid" },
    form: { CallSid: "call-opaque" },
  }), {
    isValid: true,
    matchedUrl: "https://relay.example/canonical",
    hasSignature: true,
  });
  assert.deepEqual(harness.validated, [
    "https://relay.example/request",
    "https://relay.example/canonical",
  ]);

  const receivedAt = "2026-08-27T12:00:00.000Z";
  const inboundCall = twilioProvider.normalizeWebhookEvent({
    type: "inbound_call",
    receivedAt,
    payload: {
      CallSid: "call-opaque",
      ParentCallSid: "parent-opaque",
      From: "+12065550123",
      To: "+12065550100",
    },
  });
  assert.equal(inboundCall.type, "inbound_call");
  assert.deepEqual(inboundCall.callId, {
    provider: "twilio",
    kind: "call",
    value: "call-opaque",
  });
  assert.equal("CallSid" in inboundCall, false);

  const delivery = twilioProvider.normalizeWebhookEvent({
    type: "message_delivery_updated",
    receivedAt,
    payload: {
      MessageSid: "message-opaque",
      MessageStatus: "undelivered",
      ErrorCode: "30006",
    },
  });
  assert.equal(delivery.status, "undelivered");
  assert.deepEqual(delivery.error, { code: "30006", message: null });
  assert.equal("MessageSid" in delivery, false);
});
