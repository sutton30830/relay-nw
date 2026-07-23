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
  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(() => {
    throw new Error(`Unexpected import in ${path}`);
  }, module, module.exports);
  return module.exports;
}

const { computeSetupReadiness } = await loadTsModule("lib/readiness.ts");

function signals(overrides = {}) {
  return {
    role: "owner",
    hasProfile: true,
    smsEnabled: true,
    a2pStatus: "approved",
    hasRecoveredCall: true,
    lastRecoveredCallAt: "2026-07-22T12:00:00.000Z",
    ...overrides,
  };
}

test("a real missed call is the only routing evidence", () => {
  const ready = computeSetupReadiness(signals());
  const waiting = computeSetupReadiness(signals({ hasRecoveredCall: false, lastRecoveredCallAt: null }));

  assert.equal(ready.callCaptureReady, true);
  assert.deepEqual(ready.evidence, {
    label: "Caught a real missed call",
    at: "2026-07-22T12:00:00.000Z",
  });
  assert.equal(waiting.callCaptureReady, false);
  assert.equal(waiting.evidence, null);
  assert.match(waiting.checks.find((check) => check.key === "routing").detail, /confirm this automatically/i);
});

test("a missing profile remains the only editable setup action", () => {
  const result = computeSetupReadiness(signals({ hasProfile: false }));

  assert.equal(result.operatingState, "setup_needed");
  assert.deepEqual(result.nextAction, { label: "Complete your business profile", href: "/settings" });
});

test("A2P remains separate from real call capture", () => {
  const result = computeSetupReadiness(signals({ a2pStatus: "in_progress", smsEnabled: false }));

  assert.equal(result.callCaptureReady, true);
  assert.equal(result.smsRegistrationReady, false);
  assert.equal(result.operatingState, "calls_ready_sms_pending");
});
