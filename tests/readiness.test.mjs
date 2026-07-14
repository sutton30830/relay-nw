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
  const require = (specifier) => {
    throw new Error(`Unexpected import ${specifier} in pure module ${path}`);
  };
  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

const { computeSetupReadiness } = await loadTsModule("lib/readiness.ts");

function signals(overrides = {}) {
  return {
    role: "owner",
    hasProfile: true,
    callMode: "forwarding",
    smsEnabled: true,
    a2pStatus: "approved",
    forwardingStatus: "passed",
    hasRecoveredCall: true,
    lastRecoveredCallAt: null,
    forwardingLastPassedAt: null,
    ...overrides,
  };
}

test("approved A2P and SMS enabled => live_sms_on", () => {
  const r = computeSetupReadiness(signals());
  assert.equal(r.operatingState, "live_sms_on");
  assert.equal(r.state, "live_sms_on");
  assert.equal(r.stateLabel, "Live · Auto-text on");
  assert.equal(r.callCaptureReady, true);
  assert.equal(r.smsRegistrationReady, true);
  assert.equal(r.smsEnabled, true);
  assert.equal(r.nextAction, null);
  assert.ok(r.checks.every((c) => c.status === "ok"));
  assert.match(r.summary, /callers will receive an immediate reply/i);
});

test("missing profile => setup_needed and points to settings", () => {
  const r = computeSetupReadiness(signals({ hasProfile: false }));
  assert.equal(r.operatingState, "setup_needed");
  assert.equal(r.stateLabel, "Setup needed");
  assert.equal(r.callCaptureReady, false);
  assert.equal(r.nextAction?.href, "/settings");
});

test("approved A2P and SMS disabled => live_sms_paused", () => {
  const r = computeSetupReadiness(signals({ smsEnabled: false }));
  assert.equal(r.operatingState, "live_sms_paused");
  assert.equal(r.stateLabel, "Live · Auto-text paused");
  assert.equal(r.callCaptureReady, true);
  assert.equal(r.smsRegistrationReady, true);
  assert.equal(r.smsEnabled, false);
  assert.equal(r.nextAction, null);
  assert.match(r.summary, /Automatic texts are paused/i);
  assert.match(r.summary, /callers will not receive an immediate reply/i);
});

test("pending A2P with routing ready => calls_ready_sms_pending", () => {
  const r = computeSetupReadiness(signals({ a2pStatus: "in_progress", smsEnabled: false }));
  assert.equal(r.operatingState, "calls_ready_sms_pending");
  assert.equal(r.stateLabel, "Calls ready · Texting not ready");
  assert.equal(r.callCaptureReady, true);
  assert.equal(r.smsRegistrationReady, false);
  assert.equal(r.nextAction, null);
  assert.equal(r.checks.find((c) => c.key === "texting").status, "pending");
  assert.match(r.summary, /Automatic texting is not ready until carrier registration is approved/i);
  assert.doesNotMatch(r.summary, /switch on/i);
});

test("rejected A2P presents an actionable texting problem", () => {
  const r = computeSetupReadiness(signals({ a2pStatus: "rejected", smsEnabled: false }));
  const texting = r.checks.find((c) => c.key === "texting");
  assert.equal(r.operatingState, "calls_ready_sms_pending");
  assert.equal(texting.status, "blocked");
  assert.match(texting.detail, /rejected/i);
  assert.match(texting.detail, /re-file/i);
  assert.match(r.summary, /carrier registration was rejected/i);
  assert.equal(r.nextAction?.label, "Resolve carrier registration");
});

test("A2P rejection does not masquerade as approval or owner pause", () => {
  const r = computeSetupReadiness(signals({ a2pStatus: "rejected" }));
  assert.equal(r.operatingState, "calls_ready_sms_pending");
  assert.notEqual(r.operatingState, "live_sms_paused");
  assert.equal(r.smsRegistrationReady, false);
});

test("failed forwarding test => setup_needed with re-run action", () => {
  const r = computeSetupReadiness(signals({ forwardingStatus: "failed" }));
  assert.equal(r.operatingState, "setup_needed");
  assert.equal(r.callCaptureReady, false);
  assert.equal(r.nextAction?.label, "Re-run the forwarding test");
});

test("forwarding not yet tested => setup_needed with run-test action", () => {
  const r = computeSetupReadiness(signals({ forwardingStatus: "pending" }));
  assert.equal(r.operatingState, "setup_needed");
  assert.equal(r.nextAction?.label, "Run a forwarding test");
  // Must anchor to the live-tests tool, not just reload /setup.
  assert.equal(r.nextAction?.href, "/setup#live-tests");
});

test("direct mode with no recovered call => setup_needed, prompts a test call", () => {
  const r = computeSetupReadiness(
    signals({ callMode: "direct", forwardingStatus: "unknown", hasRecoveredCall: false }),
  );
  assert.equal(r.operatingState, "setup_needed");
  assert.equal(r.nextAction?.label, "Make a test missed call");
});

test("direct mode after a real recovery => live_sms_on", () => {
  const r = computeSetupReadiness(signals({ callMode: "direct", forwardingStatus: "unknown" }));
  assert.equal(r.operatingState, "live_sms_on");
});

test("viewer with incomplete profile gets a read-only pointer", () => {
  const r = computeSetupReadiness(signals({ role: "viewer", hasProfile: false }));
  assert.equal(r.operatingState, "setup_needed");
  assert.match(r.nextAction?.label ?? "", /ask an owner/i);
});

test("toggling SMS changes only operating mode, not A2P readiness", () => {
  const on = computeSetupReadiness(signals({ a2pStatus: "approved", smsEnabled: true }));
  const off = computeSetupReadiness(signals({ a2pStatus: "approved", smsEnabled: false }));

  assert.equal(on.smsRegistrationReady, true);
  assert.equal(off.smsRegistrationReady, true);
  assert.equal(on.callCaptureReady, true);
  assert.equal(off.callCaptureReady, true);
  assert.equal(on.operatingState, "live_sms_on");
  assert.equal(off.operatingState, "live_sms_paused");
});

test("A2P approval never automatically enables an owner-paused SMS setting", () => {
  const beforeApproval = computeSetupReadiness(signals({ a2pStatus: "in_progress", smsEnabled: false }));
  const afterApproval = computeSetupReadiness(signals({ a2pStatus: "approved", smsEnabled: false }));

  assert.equal(beforeApproval.smsEnabled, false);
  assert.equal(afterApproval.smsEnabled, false);
  assert.equal(afterApproval.operatingState, "live_sms_paused");
  assert.doesNotMatch(afterApproval.summary, /turns on automatically|switch on/i);
});

test("readiness labels and supporting copy match the derived state", () => {
  const cases = [
    [signals({ forwardingStatus: "pending" }), "setup_needed", "Setup needed", /Relay needs setup/i],
    [signals({ a2pStatus: "not_started", smsEnabled: false }), "calls_ready_sms_pending", "Calls ready · Texting not ready", /Texting needs attention/i],
    [signals({ smsEnabled: true }), "live_sms_on", "Live · Auto-text on", /texting callers/i],
    [signals({ smsEnabled: false }), "live_sms_paused", "Live · Auto-text paused", /paused/i],
  ];

  for (const [input, state, label, headline] of cases) {
    const r = computeSetupReadiness(input);
    assert.equal(r.operatingState, state);
    assert.equal(r.stateLabel, label);
    assert.match(r.headline, headline);
  }
});

test("evidence: a real recovered call outranks a forwarding test", () => {
  const r = computeSetupReadiness(
    signals({
      lastRecoveredCallAt: "2026-07-10T00:00:00Z",
      forwardingLastPassedAt: "2026-07-11T00:00:00Z",
    }),
  );
  // Forwarding test is newer, so it's shown; both are candidates.
  assert.equal(r.evidence?.label, "Forwarding test passed");

  const r2 = computeSetupReadiness(
    signals({
      lastRecoveredCallAt: "2026-07-12T00:00:00Z",
      forwardingLastPassedAt: "2026-07-11T00:00:00Z",
    }),
  );
  assert.equal(r2.evidence?.label, "Caught a real missed call");
});

test("evidence: real call wins ties over a same-time forwarding test", () => {
  const r = computeSetupReadiness(
    signals({
      lastRecoveredCallAt: "2026-07-11T00:00:00Z",
      forwardingLastPassedAt: "2026-07-11T00:00:00Z",
    }),
  );
  assert.equal(r.evidence?.label, "Caught a real missed call");
});

test("evidence is null when there is no proof yet", () => {
  const r = computeSetupReadiness(signals({ lastRecoveredCallAt: null, forwardingLastPassedAt: null }));
  assert.equal(r.evidence, null);
});
