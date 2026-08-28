import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadTsModule(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
    .runInThisContext()(() => {
      throw new Error("Unexpected import");
    }, module, module.exports);
  return module.exports;
}

const { deriveA2pSyncDecision } = await loadTsModule("lib/a2p-sync.ts");

const completeEvidence = {
  registrationStatus: "VERIFIED",
  messagingServiceRegistered: true,
  numberInSenderPool: true,
  numberSmsCapable: true,
};

test("A2P approval requires campaign, service, and account-number evidence", () => {
  assert.equal(deriveA2pSyncDecision(completeEvidence).a2p, "approved");

  assert.equal(deriveA2pSyncDecision({
    ...completeEvidence,
    messagingServiceRegistered: false,
  }).a2p, "in_progress");

  assert.equal(deriveA2pSyncDecision({
    ...completeEvidence,
    numberInSenderPool: false,
  }).a2p, "needs_attention");

  assert.equal(deriveA2pSyncDecision({
    ...completeEvidence,
    numberSmsCapable: false,
  }).a2p, "needs_attention");
});

test("campaign review and failure remain carrier-controlled", () => {
  assert.equal(deriveA2pSyncDecision({
    ...completeEvidence,
    registrationStatus: "IN_REVIEW",
  }).a2p, "in_progress");
  assert.equal(deriveA2pSyncDecision({
    ...completeEvidence,
    registrationStatus: "FAILED",
  }).a2p, "rejected");
  assert.equal(deriveA2pSyncDecision({
    ...completeEvidence,
    registrationStatus: "UNKNOWN",
  }), null);
});

test("the Twilio fetch verifies the specific Relay number", async () => {
  const twilio = await readFile(new URL("../lib/telephony/providers/twilio.ts", import.meta.url), "utf8");
  const route = await readFile(
    new URL("../app/api/ops/carrier/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(twilio, /serviceContext\.fetch\(\)/);
  assert.match(twilio, /serviceContext\.phoneNumbers\.list/);
  assert.match(twilio, /incomingPhoneNumbers\.list\(\{ phoneNumber: relayPhoneNumber/);
  assert.match(route, /account\.relayNumber/);
  assert.match(route, /twilio_brand_sid: external\.brandRegistrationReference/);
});
