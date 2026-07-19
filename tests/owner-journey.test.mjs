import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadTsModule(path) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  const require = (specifier) => { throw new Error(`Unexpected import ${specifier}`); };
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

const { computeOwnerJourney } = await loadTsModule("lib/owner-journey.ts");

const base = {
  setupFeeStatus: "due",
  profileComplete: false,
  twilioNumberAssigned: false,
  a2pStatus: "not_started",
  billingStatus: "not_started",
  callCaptureVerified: false,
};

test("fresh account: kickoff is current and the customer's turn", () => {
  const j = computeOwnerJourney(base);
  assert.equal(j.currentIndex, 0);
  assert.equal(j.phases[0].state, "current");
  assert.equal(j.phases[0].turn, "you");
});

test("waived fee counts as done and advances to details", () => {
  const j = computeOwnerJourney({ ...base, setupFeeStatus: "waived" });
  assert.equal(j.phases[0].state, "done");
  assert.equal(j.currentIndex, 1);
  assert.equal(j.phases[1].turn, "you");
});

test("number phase is Relay's turn, not the customer's", () => {
  const j = computeOwnerJourney({ ...base, setupFeeStatus: "paid", profileComplete: true });
  assert.equal(j.currentIndex, 2);
  assert.equal(j.phases[2].turn, "relay");
});

test("carrier review is the carrier's turn with a calm nothing-needed message", () => {
  const j = computeOwnerJourney({
    ...base, setupFeeStatus: "paid", profileComplete: true, twilioNumberAssigned: true, a2pStatus: "in_progress",
  });
  assert.equal(j.currentIndex, 3);
  assert.equal(j.phases[3].turn, "carrier");
  assert.match(j.phases[3].detail, /nothing needed from you/i);
});

test("carrier rejection becomes Relay's problem, not the customer's", () => {
  const j = computeOwnerJourney({
    ...base, setupFeeStatus: "paid", profileComplete: true, twilioNumberAssigned: true, a2pStatus: "rejected",
  });
  assert.equal(j.phases[3].turn, "relay");
});

test("approved carrier moves to go-live, customer's turn for the test call", () => {
  const j = computeOwnerJourney({
    ...base, setupFeeStatus: "paid", profileComplete: true, twilioNumberAssigned: true, a2pStatus: "approved",
  });
  assert.equal(j.currentIndex, 4);
  assert.equal(j.phases[4].turn, "you");
});

test("fully live: all phases done", () => {
  const j = computeOwnerJourney({
    setupFeeStatus: "paid", profileComplete: true, twilioNumberAssigned: true,
    a2pStatus: "approved", billingStatus: "active", activatedAt: "2026-07-01", callCaptureVerified: true,
  });
  assert.ok(j.phases.every((p) => p.state === "done"));
});

test("first-paid activation settles kickoff even without explicit fee status", () => {
  const j = computeOwnerJourney({ ...base, setupFeeStatus: "due", firstPaidAt: "2026-07-01" });
  assert.equal(j.phases[0].state, "done");
});
