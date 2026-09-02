import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const path = "lib/owner-service-status.ts";
const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
  .runInThisContext()(() => ({}), module, module.exports);

const { canTextFromRelayNumber, deriveOwnerServiceStatus } = module.exports;

const live = {
  technicalStatus: "live",
  a2pStatus: "not_started",
  smsEnabled: false,
  voicemailTranscriptionEnabled: true,
  transcriptionProviderConfigured: true,
};

test("texting from the Relay number requires A2P approval and the owner's switch", () => {
  for (const a2pStatus of ["not_started", "in_progress", "needs_attention", "rejected", "paused", null, undefined, "bogus"]) {
    assert.equal(canTextFromRelayNumber({ a2pStatus, smsEnabled: true }), false, `a2p=${a2pStatus}`);
    assert.equal(deriveOwnerServiceStatus({ ...live, a2pStatus, smsEnabled: true }).canTextFromRelay, false);
  }
  assert.equal(canTextFromRelayNumber({ a2pStatus: "approved", smsEnabled: false }), false);
  assert.equal(canTextFromRelayNumber({ a2pStatus: "approved", smsEnabled: true }), true);
});

test("RYCO shape: calls live, transcription on, texting waiting on carrier registration", () => {
  const status = deriveOwnerServiceStatus(live);
  assert.equal(status.calls.tone, "ready");
  assert.equal(status.transcription.tone, "ready");
  assert.equal(status.texting.tone, "pending");
  assert.equal(status.texting.owner, "relay");
  assert.equal(status.canTextFromRelay, false);
  assert.match(status.texting.label, /carrier registration/i);
  assert.match(status.texting.nextStep, /nothing is needed from you/i);
  assert.match(status.texting.nextStep, /text from your own phone/i);
  assert.match(status.headline, /catching calls/i);
  assert.match(status.headline, /not on yet/i);
  // Blocked texting is never framed as a failure or as the owner's fault.
  assert.doesNotMatch(status.texting.label, /fail|error|off\b/i);
});

test("A2P approval makes texting the owner's step, and the owner's switch turns it on", () => {
  const ready = deriveOwnerServiceStatus({ ...live, a2pStatus: "approved" });
  assert.equal(ready.texting.owner, "you");
  assert.equal(ready.texting.tone, "attention");
  assert.match(ready.texting.nextStep, /Settings/);
  assert.equal(ready.canTextFromRelay, false);

  const on = deriveOwnerServiceStatus({ ...live, a2pStatus: "approved", smsEnabled: true });
  assert.equal(on.texting.tone, "ready");
  assert.equal(on.texting.nextStep, null);
  assert.equal(on.canTextFromRelay, true);
  assert.match(on.headline, /texting callers back/i);
});

test("carrier attention states stay Relay-owned and keep calls honest", () => {
  for (const a2pStatus of ["needs_attention", "rejected", "paused"]) {
    const status = deriveOwnerServiceStatus({ ...live, a2pStatus, smsEnabled: true });
    assert.equal(status.texting.owner, "relay");
    assert.equal(status.canTextFromRelay, false);
    assert.equal(status.calls.tone, "ready", "A2P never changes call status");
    assert.match(status.texting.detail, /Relay's side/);
  }
});

test("transcription readiness is independent of calls and texting", () => {
  const noKey = deriveOwnerServiceStatus({ ...live, transcriptionProviderConfigured: false });
  assert.equal(noKey.transcription.tone, "pending");
  assert.equal(noKey.transcription.label, "Recording only");
  assert.equal(noKey.calls.tone, "ready");

  const disabled = deriveOwnerServiceStatus({ ...live, voicemailTranscriptionEnabled: false });
  assert.equal(disabled.transcription.tone, "pending");
  assert.match(disabled.transcription.nextStep, /listen to recordings/i);

  const texting = deriveOwnerServiceStatus({ ...live, a2pStatus: "approved", smsEnabled: true, transcriptionProviderConfigured: false });
  assert.equal(texting.canTextFromRelay, true, "texting does not depend on transcription");
  assert.equal(texting.transcription.tone, "pending");
});

test("calls status never claims live from an unknown, missing, paused, or closed state", () => {
  for (const technicalStatus of [null, undefined, "", "bogus", "setting_up"]) {
    const status = deriveOwnerServiceStatus({ ...live, technicalStatus });
    assert.equal(status.calls.tone, "pending", `technical=${technicalStatus}`);
    assert.equal(status.calls.label, "Being set up");
    assert.match(status.headline, /getting your line ready/i);
  }
  const forwarding = deriveOwnerServiceStatus({ ...live, technicalStatus: "waiting_for_forwarding" });
  assert.equal(forwarding.calls.owner, "you");
  assert.match(forwarding.calls.nextStep, /conditional forwarding/i);
  assert.match(forwarding.headline, /one step/i);

  for (const technicalStatus of ["paused", "closed"]) {
    const status = deriveOwnerServiceStatus({ ...live, technicalStatus });
    assert.equal(status.calls.tone, "off");
    assert.match(status.headline, /not catching calls/i);
  }
});

test("owner-facing copy never exposes carrier review or internal vocabulary", () => {
  const states = [
    live,
    { ...live, a2pStatus: "approved" },
    { ...live, a2pStatus: "rejected" },
    { ...live, technicalStatus: "waiting_for_forwarding" },
    { ...live, transcriptionProviderConfigured: false },
  ];
  for (const input of states) {
    const status = deriveOwnerServiceStatus(input);
    const text = JSON.stringify(status);
    assert.doesNotMatch(text, /carrier review|A2P|10DLC|Twilio|Stripe|ISV|onboarding_status/);
  }
});
