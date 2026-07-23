import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const path = "lib/customer-experience-contract.ts";
const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
}).outputText;
const module = { exports: {} };
new vm.Script(`(function(module, exports) { ${compiled}\n})`, { filename: path })
  .runInThisContext()(module, module.exports);

const {
  canEnableAutomaticTexting,
  canStartMonthlyBilling,
  deriveCustomerBillingView,
  deriveCustomerSetupView,
  setupFeeIsCommerciallySettled,
  shouldMarkTechnicalSetupLive,
} = module.exports;

test("a valid first real missed call completes Phase 1", () => {
  assert.equal(shouldMarkTechnicalSetupLive({
    technicalStatus: "waiting_for_forwarding",
    insertedNewMissedCall: true,
    twilioSignatureValid: true,
  }), true);
});

test("duplicates and unverified webhooks cannot complete Phase 1", () => {
  assert.equal(shouldMarkTechnicalSetupLive({
    technicalStatus: "waiting_for_forwarding",
    insertedNewMissedCall: false,
    twilioSignatureValid: true,
  }), false);
  assert.equal(shouldMarkTechnicalSetupLive({
    technicalStatus: "waiting_for_forwarding",
    insertedNewMissedCall: true,
    twilioSignatureValid: false,
  }), false);
});

test("first-call automation never reopens paused or closed accounts", () => {
  for (const technicalStatus of ["live", "paused", "closed"]) {
    assert.equal(shouldMarkTechnicalSetupLive({
      technicalStatus,
      insertedNewMissedCall: true,
      twilioSignatureValid: true,
    }), false);
  }
});

test("A2P cannot block live call capture", () => {
  for (const a2pStatus of ["not_started", "in_progress", "needs_attention", "rejected", "paused"]) {
    assert.equal(deriveCustomerSetupView({
      technicalStatus: "live",
      a2pStatus,
      smsEnabled: false,
    }), "calls_live_texting_pending");
  }
});

test("A2P approval permits texting but does not turn it on", () => {
  assert.equal(canEnableAutomaticTexting("approved"), true);
  assert.equal(deriveCustomerSetupView({
    technicalStatus: "live",
    a2pStatus: "approved",
    smsEnabled: false,
  }), "calls_live_texting_available");
  assert.equal(deriveCustomerSetupView({
    technicalStatus: "live",
    a2pStatus: "approved",
    smsEnabled: true,
  }), "calls_live_texting_on");
});

test("monthly billing is gated only by technical go-live", () => {
  assert.equal(canStartMonthlyBilling("setting_up"), false);
  assert.equal(canStartMonthlyBilling("waiting_for_forwarding"), false);
  assert.equal(canStartMonthlyBilling("live"), true);
  assert.equal(canStartMonthlyBilling("paused"), false);
  assert.equal(canStartMonthlyBilling("closed"), false);
});

test("waivers and comps are Relay policy, not fake Stripe payments", () => {
  assert.equal(setupFeeIsCommerciallySettled({
    policy: "setup_fee_waived",
    paymentStatus: "not_started",
  }), true);
  assert.equal(setupFeeIsCommerciallySettled({
    policy: "comped",
    paymentStatus: "not_started",
  }), true);
  assert.equal(setupFeeIsCommerciallySettled({
    policy: "standard",
    paymentStatus: "not_started",
  }), false);
});

test("Stripe status drives the customer billing presentation", () => {
  assert.equal(deriveCustomerBillingView({
    policy: "standard",
    stripeSubscriptionStatus: "active",
    cancelAtPeriodEnd: false,
  }), "active");
  assert.equal(deriveCustomerBillingView({
    policy: "standard",
    stripeSubscriptionStatus: "active",
    cancelAtPeriodEnd: true,
  }), "canceling");
  assert.equal(deriveCustomerBillingView({
    policy: "standard",
    stripeSubscriptionStatus: "past_due",
    cancelAtPeriodEnd: false,
  }), "payment_attention");
  assert.equal(deriveCustomerBillingView({
    policy: "comped",
    stripeSubscriptionStatus: "not_started",
    cancelAtPeriodEnd: false,
  }), "comped");
});
