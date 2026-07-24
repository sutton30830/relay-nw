import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const path = "lib/customer-experience-contract.ts";
const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
const currentBillingSource = await readFile(
  new URL("../lib/billing.ts", import.meta.url),
  "utf8",
);
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
  authorityForBillingFact,
  canEnableAutomaticTexting,
  canStartMonthlyTrial,
  commercialTermsForOffer,
  deriveCustomerBillingView,
  deriveCustomerSetupView,
  isAutomaticTextBackActive,
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

test("calls can be ready while texting and monthly trial remain pending", () => {
  const setupView = deriveCustomerSetupView({
    technicalStatus: "live",
    a2pStatus: "in_progress",
    smsEnabled: false,
  });

  assert.equal(setupView, "calls_live_texting_pending");
  assert.equal(isAutomaticTextBackActive({
    technicalStatus: "live",
    a2pStatus: "in_progress",
    smsEnabled: false,
  }), false);
  assert.equal(canStartMonthlyTrial({
    technicalStatus: "live",
    a2pStatus: "in_progress",
    smsEnabled: false,
    blockedBy: "carrier",
  }), false);
});

test("monthly trial starts only after approved automatic text-back is active", () => {
  const base = {
    technicalStatus: "live",
    a2pStatus: "approved",
    smsEnabled: true,
    blockedBy: "none",
  };

  assert.equal(canStartMonthlyTrial(base), true);
  assert.equal(canStartMonthlyTrial({ ...base, technicalStatus: "waiting_for_forwarding" }), false);
  assert.equal(canStartMonthlyTrial({ ...base, a2pStatus: "in_progress" }), false);
  assert.equal(canStartMonthlyTrial({ ...base, smsEnabled: false }), false);
});

test("standard customers receive a 14-day trial after paying the setup fee", () => {
  assert.deepEqual(commercialTermsForOffer("standard"), {
    setupFeeCents: 15_000,
    setupFeeTreatment: "required",
    trialDays: 14,
  });
});

test("founding pilots receive an audited waiver and a 30-day trial", () => {
  assert.deepEqual(commercialTermsForOffer("founding_pilot"), {
    setupFeeCents: 15_000,
    setupFeeTreatment: "waived",
    trialDays: 30,
  });
});

test("customer and carrier delays never start monthly trial time", () => {
  const otherwiseReady = {
    technicalStatus: "live",
    a2pStatus: "approved",
    smsEnabled: true,
  };

  assert.equal(canStartMonthlyTrial({ ...otherwiseReady, blockedBy: "customer" }), false);
  assert.equal(canStartMonthlyTrial({ ...otherwiseReady, blockedBy: "carrier" }), false);
  assert.equal(canStartMonthlyTrial({ ...otherwiseReady, blockedBy: "relay" }), false);
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
  assert.equal(authorityForBillingFact("setup_fee_waiver"), "relay");
  assert.equal(authorityForBillingFact("comped_service"), "relay");
});

test("Stripe remains authoritative for every customer money fact", () => {
  for (const fact of [
    "payment_method",
    "setup_fee_payment",
    "subscription",
    "trial",
    "invoice",
    "refund",
    "dispute",
    "retry",
    "cancellation",
  ]) {
    assert.equal(authorityForBillingFact(fact), "stripe");
  }
});

test("Phase 1 runtime uses the delayed-trial contract", () => {
  assert.match(currentBillingSource, /canStartMonthlyTrial/);
  assert.doesNotMatch(currentBillingSource, /canStartMonthlyBilling/);
  assert.match(currentBillingSource, /initial_trial_managed_automatically/);
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
