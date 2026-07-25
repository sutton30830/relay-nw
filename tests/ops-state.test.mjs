import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../lib/ops-state.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
new vm.Script(`(function(module, exports) { ${compiled}\n})`).runInThisContext()(
  module,
  module.exports,
);

const {
  deriveOpsBillingState,
  deriveOpsCallsState,
  deriveOpsState,
  deriveOpsTextingState,
  normalizeOpsBlocker,
} = module.exports;

const canonicalCalls = {
  setting_up: "setting_up",
  waiting_for_forwarding: "waiting_for_forwarding",
  ready: "live",
  paused: "paused",
};

const canonicalTexting = {
  preparing: "not_started",
  carrier_review: "in_progress",
  approved: "approved",
  issue: "needs_attention",
};

const canonicalBilling = {
  setup_due: {
    billingStatus: "not_started",
    stripeSubscriptionStatus: null,
    setupFeeStatus: "due",
    stripeDefaultPaymentMethodId: null,
  },
  card_needed: {
    billingStatus: "not_started",
    stripeSubscriptionStatus: null,
    setupFeeStatus: "paid",
    stripeDefaultPaymentMethodId: null,
  },
  card_ready: {
    billingStatus: "not_started",
    stripeSubscriptionStatus: null,
    setupFeeStatus: "paid",
    stripeDefaultPaymentMethodId: "pm_1",
  },
  free: {
    billingStatus: "comped",
    billingPolicy: "comped",
    freeAccessReviewAt: "2026-12-01T12:00:00.000Z",
    stripeSubscriptionStatus: null,
    setupFeeStatus: "due",
    stripeDefaultPaymentMethodId: null,
  },
  trial: {
    billingStatus: "trialing",
    stripeSubscriptionStatus: "trialing",
    setupFeeStatus: "paid",
    stripeDefaultPaymentMethodId: "pm_1",
  },
  active: {
    billingStatus: "active",
    stripeSubscriptionStatus: "active",
    setupFeeStatus: "paid",
    stripeDefaultPaymentMethodId: "pm_1",
  },
  attention: {
    billingStatus: "past_due",
    stripeSubscriptionStatus: "past_due",
    setupFeeStatus: "paid",
    stripeDefaultPaymentMethodId: "pm_1",
  },
  canceled: {
    billingStatus: "canceled",
    stripeSubscriptionStatus: "canceled",
    setupFeeStatus: "paid",
    stripeDefaultPaymentMethodId: "pm_1",
  },
};

function input(overrides = {}) {
  return {
    technicalStatus: "setting_up",
    a2pStatus: "not_started",
    smsEnabled: false,
    billingStatus: "not_started",
    billingPolicy: "standard",
    freeAccessReviewAt: null,
    stripeSubscriptionStatus: null,
    setupFeeStatus: "due",
    stripeDefaultPaymentMethodId: null,
    cancelAtPeriodEnd: false,
    blockedBy: "none",
    blockerNote: null,
    blockedSince: null,
    now: new Date("2026-07-23T12:00:00.000Z"),
    ...overrides,
  };
}

test("domain state mappings expose only the target Calls, Texting, and Billing models", () => {
  for (const [expected, value] of Object.entries(canonicalCalls)) {
    assert.equal(deriveOpsCallsState(value), expected);
  }
  assert.equal(deriveOpsCallsState("closed"), "paused");
  assert.equal(deriveOpsCallsState("unknown"), "setting_up");

  for (const [expected, value] of Object.entries(canonicalTexting)) {
    assert.equal(deriveOpsTextingState(value), expected);
  }
  assert.equal(deriveOpsTextingState("rejected"), "issue");
  assert.equal(deriveOpsTextingState("paused"), "issue");

  for (const [expected, billing] of Object.entries(canonicalBilling)) {
    assert.equal(deriveOpsBillingState(input(billing)), expected);
  }
});

test("every domain combination produces one valid queue and one valid next action", () => {
  const queues = new Set(["needs_attention", "onboarding", "running", "paused"]);
  const callsStates = new Set(Object.keys(canonicalCalls));
  const textingStates = new Set(Object.keys(canonicalTexting));
  const billingStates = new Set(Object.keys(canonicalBilling));
  const blockers = ["none", "relay", "customer", "carrier"];
  let combinations = 0;

  for (const [expectedCalls, technicalStatus] of Object.entries(canonicalCalls)) {
    for (const [expectedTexting, a2pStatus] of Object.entries(canonicalTexting)) {
      for (const [expectedBilling, billing] of Object.entries(canonicalBilling)) {
        for (const blockedBy of blockers) {
          for (const smsEnabled of [false, true]) {
            for (const cancelAtPeriodEnd of [false, true]) {
              combinations += 1;
              const state = deriveOpsState(input({
                technicalStatus,
                a2pStatus,
                ...billing,
                smsEnabled,
                cancelAtPeriodEnd,
                blockedBy,
                blockerNote: blockedBy === "none" ? null : `${blockedBy} owns this blocker`,
                blockedSince: blockedBy === "none" ? null : "2026-07-20T12:00:00.000Z",
              }));

              assert.equal(state.calls, expectedCalls);
              assert.equal(state.texting, expectedTexting);
              assert.equal(state.billing, expectedBilling);
              assert.ok(callsStates.has(state.calls));
              assert.ok(textingStates.has(state.texting));
              assert.ok(billingStates.has(state.billing));
              assert.ok(queues.has(state.queueGroup));
              assert.equal(typeof state.nextAction.key, "string");
              assert.ok(state.nextAction.label.length > 0);
              assert.ok(state.nextAction.detail.length > 0);
              assert.equal(state.blockedAgeDays, blockedBy === "none" ? null : 3);
            }
          }
        }
      }
    }
  }

  assert.equal(combinations, 2048);
});

test("explicit blocker ownership always wins the next-action decision", () => {
  const ready = {
    technicalStatus: "live",
    a2pStatus: "approved",
    smsEnabled: true,
    ...canonicalBilling.active,
  };

  const relay = deriveOpsState(input({
    ...ready,
    blockedBy: "relay",
    blockerNote: "Relay must repair routing",
    blockedSince: "2026-07-22T12:00:00.000Z",
  }));
  const customer = deriveOpsState(input({
    ...ready,
    blockedBy: "customer",
    blockerNote: "Customer must enable forwarding",
    blockedSince: "2026-07-22T12:00:00.000Z",
  }));
  const carrier = deriveOpsState(input({
    ...ready,
    blockedBy: "carrier",
    blockerNote: "Carrier review needs completion",
    blockedSince: "2026-07-22T12:00:00.000Z",
  }));

  assert.equal(relay.nextAction.key, "resolve_relay_blocker");
  assert.equal(customer.nextAction.key, "follow_up_customer");
  assert.equal(carrier.nextAction.key, "monitor_carrier_blocker");
  assert.equal(relay.queueGroup, "needs_attention");
  assert.equal(customer.queueGroup, "needs_attention");
  assert.equal(carrier.queueGroup, "needs_attention");
});

test("signed call readiness, carrier approval, and Stripe truth stay independent", () => {
  const callsReady = deriveOpsState(input({
    technicalStatus: "live",
    a2pStatus: "in_progress",
    ...canonicalBilling.card_ready,
  }));
  assert.equal(callsReady.calls, "ready");
  assert.equal(callsReady.texting, "carrier_review");
  assert.equal(callsReady.billing, "card_ready");
  assert.equal(callsReady.nextAction.key, "monitor_carrier_review");

  const stripeAttention = deriveOpsState(input({
    technicalStatus: "live",
    a2pStatus: "approved",
    smsEnabled: true,
    ...canonicalBilling.attention,
  }));
  assert.equal(stripeAttention.calls, "ready");
  assert.equal(stripeAttention.texting, "approved");
  assert.equal(stripeAttention.billing, "attention");
  assert.equal(stripeAttention.nextAction.key, "resolve_billing");
});

test("approved texting still requires automatic text-back before trial activation", () => {
  const state = deriveOpsState(input({
    technicalStatus: "live",
    a2pStatus: "approved",
    smsEnabled: false,
    ...canonicalBilling.card_ready,
  }));

  assert.equal(state.texting, "approved");
  assert.equal(state.queueGroup, "onboarding");
  assert.equal(state.nextAction.key, "enable_text_back");
});

test("Relay comp never manufactures Stripe trial or active state", () => {
  const state = deriveOpsState(input({
    technicalStatus: "live",
    a2pStatus: "approved",
    smsEnabled: true,
    billingStatus: "comped",
    billingPolicy: "comped",
    freeAccessReviewAt: "2026-12-01T12:00:00.000Z",
    stripeSubscriptionStatus: null,
    setupFeeStatus: "waived",
    stripeDefaultPaymentMethodId: null,
  }));

  assert.equal(state.billing, "free");
  assert.equal(state.queueGroup, "running");
  assert.equal(state.nextAction.key, "none");
  assert.equal(state.freeAccessReviewAt, "2026-12-01T12:00:00.000Z");
});

test("a paid setup fee with no saved card asks only for a no-charge card setup", () => {
  const state = deriveOpsState(input({
    ...canonicalBilling.card_needed,
  }));

  assert.equal(state.billing, "card_needed");
  assert.equal(state.labels.billing, "Card needed");
  assert.equal(state.nextAction.key, "collect_payment_method");
  assert.match(state.nextAction.detail, /setup fee is settled/i);
});

test("operator-selected free access review becomes attention without creating billing", () => {
  const state = deriveOpsState(input({
    technicalStatus: "live",
    a2pStatus: "approved",
    smsEnabled: true,
    ...canonicalBilling.free,
    freeAccessReviewAt: "2026-07-01T12:00:00.000Z",
  }));

  assert.equal(state.billing, "free");
  assert.equal(state.queueGroup, "needs_attention");
  assert.equal(state.nextAction.key, "review_free_access");
  assert.match(state.nextAction.detail, /nothing charges automatically/i);
});

test("scheduled cancellation remains Stripe-owned and running through period end", () => {
  const state = deriveOpsState(input({
    technicalStatus: "live",
    a2pStatus: "approved",
    smsEnabled: true,
    ...canonicalBilling.active,
    cancelAtPeriodEnd: true,
  }));

  assert.equal(state.billing, "active");
  assert.equal(state.queueGroup, "running");
  assert.equal(state.nextAction.key, "review_cancellation");
});

test("commercial setup is resolved before Relay spends time provisioning", () => {
  const state = deriveOpsState(input({
    technicalStatus: "setting_up",
    a2pStatus: "not_started",
    ...canonicalBilling.setup_due,
  }));

  assert.equal(state.nextAction.key, "complete_setup_payment");
});

test("a canceled Stripe subscription outranks unrelated setup work", () => {
  const state = deriveOpsState(input({
    technicalStatus: "setting_up",
    a2pStatus: "needs_attention",
    ...canonicalBilling.canceled,
  }));

  assert.equal(state.nextAction.key, "review_canceled_subscription");
});

test("unknown blocker values fail closed to none without inventing a reason or age", () => {
  assert.equal(normalizeOpsBlocker("someone_else"), "none");
  const state = deriveOpsState(input({
    blockedBy: "someone_else",
    blockerNote: "must not leak",
    blockedSince: "2026-07-20T12:00:00.000Z",
  }));
  assert.equal(state.blockedBy, "none");
  assert.equal(state.blockerNote, null);
  assert.equal(state.blockedAgeDays, null);
});
