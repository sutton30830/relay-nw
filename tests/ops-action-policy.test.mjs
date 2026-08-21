import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(
  new URL("../lib/ops-actions.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const module = { exports: {} };
new vm.Script(`(function(require, module, exports) { ${compiled}\n})`)   
  .runInThisContext()(() => {
    throw new Error("ops-actions has no runtime dependencies");
  }, module, module.exports);

const {
  OPS_ACTIONS,
  STRIPE_ONLY_ACTIONS,
  COMMERCIAL_EXCEPTION_ACTIONS,
  canPerformOpsAction,
  hasExplicitOpsConfirmation,
} = module.exports;

test("support is strictly read-only", () => {
  assert.equal(canPerformOpsAction("support", OPS_ACTIONS.accountRead), true);
  assert.equal(canPerformOpsAction("support", OPS_ACTIONS.diagnosticsRead), true);
  for (const action of Object.values(OPS_ACTIONS)) {
    if (action === OPS_ACTIONS.accountRead || action === OPS_ACTIONS.diagnosticsRead) continue;
    assert.equal(canPerformOpsAction("support", action), false, action);
  }
});

test("operators have setup actions but no commercial, closure, paid-pause, or Stripe powers", () => {
  for (const action of [
    OPS_ACTIONS.profileEdit,
    OPS_ACTIONS.assignExistingNumber,
    OPS_ACTIONS.a2pSync,
    OPS_ACTIONS.voicemailRecovery,
    OPS_ACTIONS.blockerManage,
    OPS_ACTIONS.billingLinkSend,
    OPS_ACTIONS.onboardingPause,
    OPS_ACTIONS.trialActivate,
  ]) {
    assert.equal(canPerformOpsAction("operator", action), true, action);
  }
  for (const action of [
    ...COMMERCIAL_EXCEPTION_ACTIONS,
    OPS_ACTIONS.accountClose,
    OPS_ACTIONS.accountReopen,
    ...STRIPE_ONLY_ACTIONS,
  ]) {
    assert.equal(canPerformOpsAction("operator", action), false, action);
  }
});

test("super admins own Relay exceptions but Stripe-only actions remain impossible", () => {
  for (const action of [
    ...COMMERCIAL_EXCEPTION_ACTIONS,
    OPS_ACTIONS.accountClose,
    OPS_ACTIONS.accountReopen,
  ]) {
    assert.equal(canPerformOpsAction("super_admin", action), true, action);
  }
  for (const action of STRIPE_ONLY_ACTIONS) {
    assert.equal(canPerformOpsAction("super_admin", action), false, action);
  }
});

test("sensitive actions require an exact explicit confirmation value", () => {
  assert.equal(hasExplicitOpsConfirmation("confirmed"), true);
  for (const value of [null, "", "true", "yes", "on"]) {
    assert.equal(hasExplicitOpsConfirmation(value), false);
  }
});
