import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../lib/ops-lifecycle.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
new vm.Script(`(function(module, exports) { ${compiled}\n})`).runInThisContext()(module, module.exports);
const { getOpsLifecycle } = module.exports;

test("ops lifecycle uses plain-language stages", () => {
  assert.equal(getOpsLifecycle({ onboardingStatus: "carrier_review", billingStatus: "not_started" }).stage, "carrier_review");
  assert.equal(getOpsLifecycle({ onboardingStatus: "carrier_review", billingStatus: "not_started" }).label, "Carrier review");
  assert.equal(getOpsLifecycle({ onboardingStatus: "ready_to_activate", billingStatus: "not_started" }).primaryAction, "Activate");
  assert.equal(getOpsLifecycle({ onboardingStatus: "activated", billingStatus: "active" }).stage, "active");
  assert.equal(getOpsLifecycle({ onboardingStatus: "activated", billingStatus: "canceled" }).stage, "canceled");
});

test("scheduled cancellation is visible even while Stripe still reports active", () => {
  const lifecycle = getOpsLifecycle({
    onboardingStatus: "activated",
    billingStatus: "active",
    activatedAt: "2026-07-17T23:32:45.050Z",
    cancelAtPeriodEnd: true,
    currentPeriodEnd: "2026-08-18T23:49:50.000Z",
  });

  assert.equal(lifecycle.stage, "canceled");
  assert.equal(lifecycle.label, "Canceling");
  assert.equal(lifecycle.blockedOn, "Subscription ends Aug 18, 2026");
  assert.equal(lifecycle.primaryAction, "Review cancellation");
});
