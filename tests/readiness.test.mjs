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

test("everything verified => live, no next action", () => {
  const r = computeSetupReadiness(signals());
  assert.equal(r.state, "live");
  assert.equal(r.nextAction, null);
  assert.ok(r.checks.every((c) => c.status === "ok"));
});

test("missing profile => not_ready and points to settings", () => {
  const r = computeSetupReadiness(signals({ hasProfile: false }));
  assert.equal(r.state, "not_ready");
  assert.equal(r.nextAction?.href, "/settings");
});

test("core verified but texting off by choice => still live, no nag", () => {
  const r = computeSetupReadiness(signals({ smsEnabled: false }));
  assert.equal(r.state, "live");
  assert.equal(r.nextAction, null);
  assert.match(r.summary, /turn on automatic texting/i);
});

test("core verified while A2P still in review => live, texting pending, no action", () => {
  const r = computeSetupReadiness(signals({ a2pStatus: "in_progress", smsEnabled: false }));
  assert.equal(r.state, "live");
  assert.equal(r.nextAction, null);
  assert.equal(r.checks.find((c) => c.key === "texting").status, "pending");
  assert.match(r.summary, /switch on once carrier registration is approved/i);
});

test("core verified but carrier rejected => live (calls still caught), texting blocked + action", () => {
  const r = computeSetupReadiness(signals({ a2pStatus: "rejected", smsEnabled: false }));
  assert.equal(r.state, "live");
  assert.equal(r.checks.find((c) => c.key === "texting").status, "blocked");
  assert.equal(r.nextAction?.label, "Resolve carrier registration");
});

test("carrier rejected does NOT turn the account red when core works", () => {
  const r = computeSetupReadiness(signals({ a2pStatus: "rejected" }));
  assert.notEqual(r.state, "attention");
});

test("failed forwarding test => attention (core pipeline broken) with re-run action", () => {
  const r = computeSetupReadiness(signals({ forwardingStatus: "failed" }));
  assert.equal(r.state, "attention");
  assert.equal(r.nextAction?.label, "Re-run the forwarding test");
});

test("forwarding not yet tested => testing with run-test action", () => {
  const r = computeSetupReadiness(signals({ forwardingStatus: "pending" }));
  assert.equal(r.state, "testing");
  assert.equal(r.nextAction?.label, "Run a forwarding test");
  // Must anchor to the live-tests tool, not just reload /setup.
  assert.equal(r.nextAction?.href, "/setup#live-tests");
});

test("direct mode with no recovered call => testing, prompts a test call", () => {
  const r = computeSetupReadiness(
    signals({ callMode: "direct", forwardingStatus: "unknown", hasRecoveredCall: false }),
  );
  assert.equal(r.state, "testing");
  assert.equal(r.nextAction?.label, "Make a test missed call");
});

test("direct mode after a real recovery => live", () => {
  const r = computeSetupReadiness(signals({ callMode: "direct", forwardingStatus: "unknown" }));
  assert.equal(r.state, "live");
});

test("viewer with incomplete profile gets a read-only pointer", () => {
  const r = computeSetupReadiness(signals({ role: "viewer", hasProfile: false }));
  assert.equal(r.state, "not_ready");
  assert.match(r.nextAction?.label ?? "", /ask an owner/i);
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
