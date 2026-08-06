import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../lib/onboarding-profile.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const module = { exports: {} };
new vm.Script(`(function(module,exports){${compiled}\n})`).runInThisContext()(module, module.exports);
const { isCustomerProfileComplete, missingCustomerProfileFields } = module.exports;

const complete = {
  legalBusinessName: "Cascade Plumbing LLC",
  businessName: "Cascade Plumbing",
  ownerName: "Sutton Lowry",
  ownerEmail: "owner@example.com",
  ownerPhoneNumber: "+12065550123",
  publicBusinessNumber: "+12065550124",
  businessType: "llc",
  callMode: "forwarding",
  forwardingCarrier: "Verizon",
  businessHours: { summary: "Mon-Fri 8-5" },
  coverageExpectations: "Capture every unanswered call.",
  smsTemplate: "Sorry we missed you. Reply STOP to opt out.",
  missedCallVoiceMessage: "Please leave a recorded message.",
};

test("customer profile completion never depends on a Relay-assigned number", () => {
  assert.equal(isCustomerProfileComplete(complete), true);
});

test("forwarding requires only owner identity and the existing public number", () => {
  const profile = { ...complete, ownerName: null, publicBusinessNumber: "", forwardingCarrier: "" };
  assert.deepEqual(missingCustomerProfileFields(profile), [
    "Owner name",
    "Existing public business number",
  ]);
});

test("carrier, hours, custom copy, and a custom greeting never block basic call setup", () => {
  const profile = {
    ...complete,
    legalBusinessName: null,
    ownerPhoneNumber: null,
    forwardingCarrier: null,
    businessHours: null,
    coverageExpectations: null,
    smsTemplate: null,
    missedCallVoiceMessage: null,
    missedCallGreetingAudioUrl: null,
  };

  assert.equal(isCustomerProfileComplete(profile), true);
});

test("direct mode does not require an existing public number", () => {
  const profile = {
    ...complete,
    callMode: "direct",
    businessType: null,
    publicBusinessNumber: null,
    forwardingCarrier: null,
  };

  assert.equal(isCustomerProfileComplete(profile), true);
});
