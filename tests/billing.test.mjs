import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadTsModule(path, mocks = {}) {
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
    if (specifier in mocks) return mocks[specifier];
    throw new Error(`Missing test mock for ${specifier} while loading ${path}`);
  };

  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

const billing = await loadTsModule("lib/billing.ts", {
  "@/lib/readiness": {},
});

const stripeBilling = await loadTsModule("lib/stripe-billing.ts", {
  "node:crypto": await import("node:crypto"),
  "@/lib/env": {
    env: {
      appBaseUrl: "https://www.relay-nw.com",
      stripeSecretKey: "sk_test_example",
      stripeWebhookSecret: "whsec_example",
      stripePriceId: "price_123",
    },
  },
  "@/lib/billing": {},
});

function setupReadiness(overrides = {}) {
  return {
    callCaptureReady: false,
    smsRegistrationReady: false,
    ...overrides,
  };
}

function billingRecord(overrides = {}) {
  return {
    billingStatus: "not_started",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripePriceId: null,
    trialEndsAt: null,
    billingUpdatedAt: null,
    ...overrides,
  };
}

test("billing waits while setup is not activation-ready", () => {
  const state = billing.computeBillingReadiness({
    billing: billingRecord(),
    setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: false }),
  });

  assert.equal(state.state, "setup_not_billable");
  assert.equal(state.activationReady, false);
  assert.equal(state.label, "Setup first");
});

test("account becomes ready to bill only after call capture and texting registration are ready", () => {
  const state = billing.computeBillingReadiness({
    billing: billingRecord(),
    setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: true }),
  });

  assert.equal(state.state, "ready_to_start_billing");
  assert.equal(state.activationReady, true);
  assert.equal(state.label, "Ready to bill");
});

test("billing lifecycle derives ready_to_activate when calls and carrier registration are ready", () => {
  const state = billing.computeBillingLifecycle({
    billing: billingRecord({ onboardingStatus: "carrier_review" }),
    setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: true }),
  });

  assert.equal(state.activationReady, true);
  assert.equal(state.onboardingStatus, "ready_to_activate");
  assert.equal(state.ownerAction, "start_billing");
  assert.equal(state.customerDelay, false);
  assert.equal(state.carrierDelay, false);
});

test("sms pause does not change billing eligibility once infrastructure is ready", () => {
  const smsPausedButReady = { callCaptureReady: true, smsRegistrationReady: true, smsEnabled: false };
  const state = billing.computeBillingLifecycle({
    billing: billingRecord(),
    setupReadiness: smsPausedButReady,
  });

  assert.equal(state.activationReady, true);
  assert.equal(state.ownerAction, "start_billing");
});

test("customer delay and carrier delay are distinct billing lifecycle states", () => {
  const waitingOnCustomer = billing.computeBillingLifecycle({
    billing: billingRecord({ onboardingStatus: "waiting_on_customer" }),
    setupReadiness: setupReadiness({ callCaptureReady: false, smsRegistrationReady: false }),
  });
  const carrierReview = billing.computeBillingLifecycle({
    billing: billingRecord({ onboardingStatus: "carrier_review" }),
    setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: false }),
  });
  const carrierAttention = billing.computeBillingLifecycle({
    billing: billingRecord({ onboardingStatus: "carrier_attention" }),
    setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: false }),
  });

  assert.equal(waitingOnCustomer.customerDelay, true);
  assert.equal(waitingOnCustomer.carrierDelay, false);
  assert.equal(waitingOnCustomer.ownerAction, "finish_setup");
  assert.equal(carrierReview.customerDelay, false);
  assert.equal(carrierReview.carrierDelay, true);
  assert.equal(carrierReview.ownerAction, "finish_setup");
  assert.equal(carrierAttention.carrierDelay, true);
  assert.equal(carrierAttention.ownerAction, "contact_support");
});

test("every simplified billing status has one unambiguous owner action", () => {
  const expectations = {
    not_started: "start_billing",
    trialing: "manage_billing",
    active: "manage_billing",
    past_due: "update_payment",
    canceled: "restart_subscription",
    comped: "manage_billing",
  };

  for (const [billingStatus, ownerAction] of Object.entries(expectations)) {
    const state = billing.computeBillingLifecycle({
      billing: billingRecord({ billingStatus }),
      setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: true }),
    });

    assert.equal(state.ownerAction, ownerAction);
  }
});

test("activation and first paid dates are durable lifecycle facts", () => {
  const state = billing.computeBillingLifecycle({
    billing: billingRecord({
      billingStatus: "canceled",
      onboardingStatus: "waiting_on_customer",
      activatedAt: "2026-07-01T00:00:00.000Z",
      firstPaidAt: "2026-07-02T00:00:00.000Z",
      guaranteeEndsAt: "2026-08-01T00:00:00.000Z",
    }),
    setupReadiness: setupReadiness({ callCaptureReady: false, smsRegistrationReady: false }),
  });

  assert.equal(state.onboardingStatus, "activated");
  assert.equal(state.ownerAction, "finish_setup");
});

test("active, trialing, and comped billing states are accepted without setup enforcement", () => {
  for (const billingStatus of ["active", "trialing", "comped"]) {
    const state = billing.computeBillingReadiness({
      billing: billingRecord({ billingStatus }),
      setupReadiness: setupReadiness(),
    });

    assert.equal(state.billingStatus, billingStatus);
    assert.notEqual(state.state, "billing_attention");
  }
});

test("past due and canceled are visible attention states but do not disable Relay in Phase 5A", () => {
  for (const billingStatus of ["past_due", "canceled"]) {
    const state = billing.computeBillingReadiness({
      billing: billingRecord({ billingStatus }),
      setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: true }),
    });

    assert.equal(state.state, "billing_attention");
    assert.equal(state.tone, "warn");
    assert.match(state.summary, /do not automatically disable/i);
  }
});

test("unknown billing status falls back to not_started", () => {
  assert.equal(billing.normalizeBillingStatus("surprise"), "not_started");
  assert.equal(billing.normalizeBillingStatus(null), "not_started");
});

test("stripe subscription statuses map into account billing states", () => {
  assert.equal(stripeBilling.mapStripeSubscriptionStatus("active"), "active");
  assert.equal(stripeBilling.mapStripeSubscriptionStatus("trialing"), "trialing");
  assert.equal(stripeBilling.mapStripeSubscriptionStatus("canceled"), "canceled");
  assert.equal(stripeBilling.mapStripeSubscriptionStatus("past_due"), "past_due");
  assert.equal(stripeBilling.mapStripeSubscriptionStatus("unpaid"), "past_due");
  assert.equal(stripeBilling.mapStripeSubscriptionStatus("incomplete"), "past_due");
  assert.equal(stripeBilling.mapStripeSubscriptionStatus("unexpected"), "not_started");
});

test("stripe webhook signatures must be valid and recent", () => {
  const rawBody = JSON.stringify({ id: "evt_123" });
  const timestamp = 1_800_000_000;
  const secret = "whsec_example";
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const header = `t=${timestamp},v1=${signature}`;

  assert.equal(stripeBilling.verifyStripeWebhookSignature(rawBody, header, secret, timestamp * 1000), true);
  assert.equal(stripeBilling.verifyStripeWebhookSignature(rawBody, header, "wrong_secret", timestamp * 1000), false);
  assert.equal(stripeBilling.verifyStripeWebhookSignature(rawBody, header, secret, (timestamp + 1_000) * 1000), false);
});

test("checkout session completed updates the selected account billing identifiers", () => {
  const update = stripeBilling.extractBillingUpdateFromStripeEvent({
    type: "checkout.session.completed",
    data: {
      object: {
        client_reference_id: "acct_123",
        customer: "cus_123",
        subscription: "sub_123",
        metadata: { account_id: "acct_123", account_slug: "relay-nw" },
      },
    },
  });

  assert.deepEqual(update, {
    accountId: "acct_123",
    billingStatus: "active",
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: "sub_123",
    stripePriceId: "price_123",
    trialEndsAt: null,
  });
});

test("subscription updates use metadata account id and preserve trial end", () => {
  const update = stripeBilling.extractBillingUpdateFromStripeEvent({
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_123",
        status: "trialing",
        trial_end: 1_800_000_000,
        metadata: { account_id: "acct_123" },
        items: {
          data: [{ price: { id: "price_trial" } }],
        },
      },
    },
  });

  assert.equal(update.accountId, "acct_123");
  assert.equal(update.billingStatus, "trialing");
  assert.equal(update.stripeCustomerId, "cus_123");
  assert.equal(update.stripeSubscriptionId, "sub_123");
  assert.equal(update.stripePriceId, "price_trial");
  assert.equal(update.trialEndsAt, "2027-01-15T08:00:00.000Z");
});

test("subscription deleted marks the account canceled", () => {
  const update = stripeBilling.extractBillingUpdateFromStripeEvent({
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_123",
        status: "active",
        metadata: { account_id: "acct_123" },
      },
    },
  });

  assert.equal(update.billingStatus, "canceled");
  assert.equal(update.accountId, "acct_123");
});

test("stripe events without account metadata are ignored instead of guessing a tenant", () => {
  assert.equal(
    stripeBilling.extractBillingUpdateFromStripeEvent({
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123", status: "active" } },
    }),
    null,
  );
});
