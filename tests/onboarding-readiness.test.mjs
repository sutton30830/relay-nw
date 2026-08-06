import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../lib/onboarding.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
new vm.Script(`(function(module,exports){${compiled}\n})`).runInThisContext()(module, module.exports);
const { deriveOnboardingReadiness } = module.exports;

const at = "2026-08-05T20:00:00.000Z";
const readyFacts = {
  accountStatus: "active",
  technicalStatus: "live",
  callMode: "forwarding",
  missingProfileFields: [],
  relayNumber: "+12065550123",
  forwardingCarrier: "Verizon",
  businessHoursConfigured: true,
  coverageExpectationsConfigured: true,
  smsTemplateConfigured: true,
  voicemailGreetingConfigured: true,
  smsComplianceConfigured: true,
  ownerAuthLinked: true,
  signedCallVerifiedAt: at,
  a2pStatus: "approved",
  smsEnabled: true,
  smsDeliveryVerifiedAt: at,
  smsDeliveryMessageSid: "SM_delivered",
  nonSmsFailureVerifiedAt: at,
  nonSmsFailureCode: "30006",
  ownerNotificationSentAt: at,
  ownerNotificationConfirmedAt: at,
  billingConfigured: true,
  billingAttentionReason: null,
  customerGoLiveApprovedAt: at,
  blockedBy: "none",
  blockerReason: null,
};

function readiness(update = {}) {
  return deriveOnboardingReadiness({ ...readyFacts, ...update });
}

test("the required readiness states follow evidence, never a stored readiness label", () => {
  assert.equal(readiness({
    relayNumber: null,
    signedCallVerifiedAt: null,
    technicalStatus: "setting_up",
    a2pStatus: "not_started",
    smsDeliveryVerifiedAt: null,
  }).state, "calls_not_configured");

  assert.equal(readiness({
    signedCallVerifiedAt: null,
    technicalStatus: "waiting_for_forwarding",
    a2pStatus: "not_started",
    smsDeliveryVerifiedAt: null,
  }).state, "awaiting_forwarding_test");

  assert.equal(readiness({ a2pStatus: "not_started", smsDeliveryVerifiedAt: null }).state, "calls_verified");
  assert.equal(readiness({ a2pStatus: "in_progress", smsDeliveryVerifiedAt: null }).state, "texting_registration_pending");
  assert.equal(readiness({ smsEnabled: false, smsDeliveryVerifiedAt: null }).state, "texting_approved");
  assert.equal(readiness({ nonSmsFailureVerifiedAt: null }).state, "sms_delivery_verified");
  assert.equal(readiness().state, "ready_for_production");
});

test("a Relay number, A2P, or editable approval cannot replace the signed real call", () => {
  const result = readiness({ signedCallVerifiedAt: null, technicalStatus: "live" });
  assert.equal(result.state, "awaiting_forwarding_test");
  assert.equal(result.ready, false);
  assert.equal(result.checks.find((check) => check.key === "call_verification").status, "pending");
});

test("A2P remains separate from call readiness and cannot skip the forwarding test", () => {
  const approvedBeforeCall = readiness({
    signedCallVerifiedAt: null,
    technicalStatus: "waiting_for_forwarding",
  });
  assert.equal(approvedBeforeCall.state, "awaiting_forwarding_test");
  assert.equal(approvedBeforeCall.checks.find((check) => check.key === "a2p").status, "complete");

  const callsWithoutA2p = readiness({ a2pStatus: "not_started", smsDeliveryVerifiedAt: null });
  assert.equal(callsWithoutA2p.state, "calls_verified");
  assert.equal(callsWithoutA2p.checks.find((check) => check.key === "call_verification").status, "complete");
});

test("incomplete internal evidence does not invent customer onboarding work", () => {
  const result = readiness({ nonSmsFailureVerifiedAt: null, customerGoLiveApprovedAt: at });
  assert.equal(result.ready, false);
  assert.equal(result.state, "sms_delivery_verified");
  assert.equal(result.customerAction.label, "No action needed");

  const awaitingOwnerApproval = readiness({ customerGoLiveApprovedAt: null });
  assert.equal(awaitingOwnerApproval.customerAction.label, "No action needed");
});

test("A2P or billing trouble does not globally block verified calls", () => {
  const result = readiness({
    a2pStatus: "rejected",
    billingAttentionReason: "Payment failed.",
    smsDeliveryVerifiedAt: null,
  });

  assert.equal(result.state, "calls_verified");
  assert.equal(result.blockedBy, "none");
  assert.equal(result.operatorAction.label, "Review A2P in Twilio");
});

test("blocked readiness identifies both the owner and reason", () => {
  const result = readiness({ blockedBy: "customer", blockerReason: "Carrier account PIN is missing." });
  assert.equal(result.state, "blocked");
  assert.equal(result.blockedBy, "customer");
  assert.equal(result.blockerReason, "Carrier account PIN is missing.");
  assert.equal(result.operatorAction.owner, "customer");
  assert.match(result.customerAction.detail, /Carrier account PIN/);
});

test("a blocked code-level control remains Relay-owned", () => {
  const result = readiness({ smsComplianceConfigured: false });
  assert.equal(result.state, "blocked");
  assert.equal(result.blockedBy, "relay");
  assert.match(result.blockerReason, /consent and opt-out controls/i);
});

test("every launch fact is required before Ready for production", () => {
  for (const [key, value] of [
    ["ownerAuthLinked", false],
    ["smsComplianceConfigured", false],
    ["smsDeliveryVerifiedAt", null],
    ["nonSmsFailureVerifiedAt", null],
    ["ownerNotificationConfirmedAt", null],
    ["billingConfigured", false],
    ["customerGoLiveApprovedAt", null],
  ]) {
    assert.equal(readiness({ [key]: value }).ready, false, `${key} must fail closed`);
  }
});
