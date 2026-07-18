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

test("effective onboarding treats paid or activated accounts as activated", () => {
  const activatedDate = billing.computeBillingLifecycle({
    billing: billingRecord({
      billingStatus: "canceled",
      onboardingStatus: "waiting_on_customer",
      requirementsDueAt: "2026-08-01T00:00:00.000Z",
      activatedAt: "2026-07-01T00:00:00.000Z",
    }),
    setupReadiness: setupReadiness({ callCaptureReady: false, smsRegistrationReady: false }),
  });
  const activeBilling = billing.computeBillingLifecycle({
    billing: billingRecord({
      billingStatus: "active",
      onboardingStatus: "waiting_on_customer",
      requirementsDueAt: "2026-08-01T00:00:00.000Z",
    }),
    setupReadiness: setupReadiness({ callCaptureReady: false, smsRegistrationReady: false }),
  });

  assert.equal(activatedDate.onboardingStatus, "activated");
  assert.equal(activatedDate.customerDelay, false);
  assert.equal(activeBilling.onboardingStatus, "activated");
  assert.equal(activeBilling.customerDelay, false);
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
    comped: "none",
  };

  for (const [billingStatus, ownerAction] of Object.entries(expectations)) {
    const state = billing.computeBillingLifecycle({
      billing: billingRecord({ billingStatus }),
      setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: true }),
    });

    assert.equal(state.ownerAction, ownerAction);
  }
});

test("checkout eligibility allows only not started or fully canceled accounts", () => {
  const ready = setupReadiness({ callCaptureReady: true, smsRegistrationReady: true });

  assert.deepEqual(
    billing.getBillingCheckoutEligibility({ billing: billingRecord(), setupReadiness: ready }),
    { ok: true },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({ billingStatus: "canceled", stripeSubscriptionStatus: "canceled" }),
      setupReadiness: ready,
    }),
    { ok: true },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({ billingStatus: "trialing", stripeSubscriptionId: null }),
      setupReadiness: ready,
    }),
    { ok: true },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({ billingStatus: "not_started", stripeSubscriptionStatus: "incomplete" }),
      setupReadiness: ready,
    }),
    { ok: false, reason: "subscription_incomplete" },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({ billingStatus: "past_due", stripeSubscriptionStatus: "past_due" }),
      setupReadiness: ready,
    }),
    { ok: false, reason: "past_due" },
  );
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

test("trialing billing lifecycle does not claim the account is renewing monthly", () => {
  const state = billing.computeBillingLifecycle({
    billing: billingRecord({
      billingStatus: "trialing",
      trialEndsAt: "2026-08-01T12:00:00.000Z",
    }),
    setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: true }),
  });

  assert.equal(state.label, "Trial active");
  assert.equal(state.headline, "Trial is active.");
  assert.match(state.summary, /trial is active until Aug 1, 2026/);
  assert.doesNotMatch(state.summary, /renew monthly/);
});

test("scheduled cancellation stays manageable and does not imply service shutdown", () => {
  const state = billing.computeBillingLifecycle({
    billing: billingRecord({
      billingStatus: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
    }),
    setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: true }),
  });

  assert.equal(state.label, "Active until end date");
  assert.equal(state.ownerAction, "manage_billing");
  assert.equal(state.tone, "warn");
  assert.match(state.summary, /canceled/);
  assert.match(state.summary, /keeps catching missed calls/);
});

test("scheduled cancellation is visible in billing readiness cards", () => {
  const state = billing.computeBillingReadiness({
    billing: billingRecord({
      billingStatus: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: "2026-08-16T12:00:00.000Z",
    }),
    setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: true }),
  });

  assert.equal(state.state, "active");
  assert.equal(state.label, "Active until Aug 16, 2026");
  assert.equal(state.headline, "Subscription has been canceled.");
  assert.match(state.summary, /Relay keeps working until Aug 16, 2026/);
  assert.equal(state.tone, "warn");
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

test("checkout session completed only associates billing identifiers", () => {
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
    billingStatus: "not_started",
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

test("stripe subscription snapshots preserve scheduled cancellation from cancel_at", () => {
  const snapshot = stripeBilling.stripeSubscriptionSnapshot({
    id: "sub_123",
    customer: "cus_123",
    status: "active",
    cancel_at: 1_786_924_800,
    items: {
      data: [{ price: { id: "price_123" } }],
    },
  });

  assert.equal(snapshot.cancelAtPeriodEnd, true);
  assert.equal(snapshot.currentPeriodEnd, "2026-08-17T00:00:00.000Z");
});

test("stripe subscription snapshots read period end from subscription items", () => {
  const snapshot = stripeBilling.stripeSubscriptionSnapshot({
    id: "sub_123",
    customer: "cus_123",
    status: "active",
    cancel_at_period_end: true,
    items: {
      data: [
        {
          current_period_end: 1_786_924_800,
          price: { id: "price_123" },
        },
      ],
    },
  });

  assert.equal(snapshot.cancelAtPeriodEnd, true);
  assert.equal(snapshot.currentPeriodEnd, "2026-08-17T00:00:00.000Z");
});

test("paid stripe subscription update activates onboarding and clears stale customer deadline", () => {
  const update = stripeBilling.billingUpdateFromSubscription(
    "acct_123",
    {
      id: "sub_123",
      customerId: "cus_123",
      priceId: "price_123",
      status: "active",
      trialEndsAt: null,
      currentPeriodEnd: "2026-08-17T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    },
    { nowIso: "2026-07-17T00:00:00.000Z" },
  );

  assert.equal(update.billingStatus, "active");
  assert.equal(update.onboardingStatus, "activated");
  assert.equal(update.requirementsDueAt, null);
  assert.equal(update.activatedAt, "2026-07-17T00:00:00.000Z");
  assert.equal(update.firstPaidAt, "2026-07-17T00:00:00.000Z");
  assert.equal(update.guaranteeEndsAt, "2026-08-16T00:00:00.000Z");
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

test("operator billing overrides are blocked while Stripe has a live subscription", () => {
  assert.equal(billing.canApplyOperatorBillingOverride(null), true);
  assert.equal(billing.canApplyOperatorBillingOverride(billingRecord()), true);
  assert.equal(
    billing.canApplyOperatorBillingOverride(
      billingRecord({ stripeSubscriptionId: "sub_active", stripeSubscriptionStatus: "active" }),
    ),
    false,
  );
  assert.equal(
    billing.canApplyOperatorBillingOverride(
      billingRecord({ stripeSubscriptionId: "sub_past_due", stripeSubscriptionStatus: "past_due" }),
    ),
    false,
  );
  assert.equal(
    billing.canApplyOperatorBillingOverride(
      billingRecord({ stripeSubscriptionId: "sub_canceled", stripeSubscriptionStatus: "canceled" }),
    ),
    true,
  );
  assert.equal(
    billing.canApplyOperatorBillingOverride(
      billingRecord({ stripeSubscriptionId: "sub_expired", stripeSubscriptionStatus: "incomplete_expired" }),
    ),
    true,
  );
});

test("operator trial days are clamped to a safe support range", () => {
  assert.equal(billing.normalizeOperatorTrialDays(undefined), 30);
  assert.equal(billing.normalizeOperatorTrialDays("3"), 7);
  assert.equal(billing.normalizeOperatorTrialDays("14"), 14);
  assert.equal(billing.normalizeOperatorTrialDays("120"), 90);
  assert.equal(billing.normalizeOperatorTrialDays("nope"), 30);
});

test("trial extension starts from current future trial end instead of now", () => {
  assert.equal(
    billing.addTrialDays({
      trialEndsAt: "2026-07-20T00:00:00.000Z",
      days: 10,
      now: new Date("2026-07-18T00:00:00.000Z"),
    }),
    "2026-07-30T00:00:00.000Z",
  );
  assert.equal(
    billing.addTrialDays({
      trialEndsAt: "2026-07-01T00:00:00.000Z",
      days: 7,
      now: new Date("2026-07-18T00:00:00.000Z"),
    }),
    "2026-07-25T00:00:00.000Z",
  );
});

test("expired app-level trials require billing without touching Stripe-backed trials", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");

  assert.equal(billing.chooseBillingTrialExpiryAction({
    billingStatus: "trialing",
    stripeSubscriptionId: null,
    trialEndsAt: "2026-07-31T00:00:00.000Z",
    now,
  }), "expire_app_trial");

  assert.equal(billing.chooseBillingTrialExpiryAction({
    billingStatus: "trialing",
    stripeSubscriptionId: "sub_live",
    trialEndsAt: "2026-07-31T00:00:00.000Z",
    now,
  }), "none");

  assert.equal(billing.chooseBillingTrialExpiryAction({
    billingStatus: "trialing",
    stripeSubscriptionId: null,
    trialEndsAt: "2026-08-02T00:00:00.000Z",
    now,
  }), "none");

  assert.equal(billing.chooseBillingTrialExpiryAction({
    billingStatus: "trialing",
    stripeSubscriptionId: null,
    trialEndsAt: "2026-07-31T00:00:00.000Z",
    completedActions: new Set([billing.BILLING_TRIAL_EXPIRY_ACTION]),
    now,
  }), "none");
});

test("expired app trial maps to start billing instead of update payment", () => {
  const state = billing.computeBillingLifecycle({
    billing: billingRecord({
      billingStatus: "past_due",
      stripeSubscriptionId: null,
      trialEndsAt: "2026-07-31T00:00:00.000Z",
    }),
    setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: true }),
  });

  assert.equal(state.ownerAction, "start_billing");
  assert.equal(state.label, "Trial ended");
  assert.match(state.summary, /Start billing/);
});

test("checkout trial days default to the configured Stripe trial for fresh billing", () => {
  assert.equal(
    stripeBilling.checkoutTrialPeriodDays({
      billingStatus: "not_started",
      trialEndsAt: null,
      defaultTrialDays: 30,
      now: new Date("2026-07-18T00:00:00.000Z"),
    }),
    30,
  );
});

test("checkout trial days honor remaining operator-granted trial time", () => {
  assert.equal(
    stripeBilling.checkoutTrialPeriodDays({
      billingStatus: "trialing",
      trialEndsAt: "2026-07-28T12:00:00.000Z",
      defaultTrialDays: 30,
      now: new Date("2026-07-18T00:00:00.000Z"),
    }),
    11,
  );
});

test("checkout trial days do not restart an expired app-level trial", () => {
  assert.equal(
    stripeBilling.checkoutTrialPeriodDays({
      billingStatus: "trialing",
      trialEndsAt: "2026-07-01T00:00:00.000Z",
      defaultTrialDays: 30,
      now: new Date("2026-07-18T00:00:00.000Z"),
    }),
    0,
  );
});

test("stripe Checkout session includes trial_period_days when available", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";

  globalThis.fetch = async (_url, init) => {
    requestBody = String(init.body);
    return {
      ok: true,
      json: async () => ({ id: "cs_123", url: "https://checkout.stripe.test/session" }),
    };
  };

  try {
    await stripeBilling.createStripeCheckoutSession({
      accountId: "acct_123",
      accountSlug: "demo",
      ownerEmail: "owner@example.com",
      stripeCustomerId: null,
      idempotencyKey: "checkout-key",
      trialPeriodDays: 30,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const params = new URLSearchParams(requestBody);
  assert.equal(params.get("subscription_data[trial_period_days]"), "30");
  assert.equal(params.get("metadata[account_id]"), "acct_123");
  assert.equal(params.get("customer_email"), "owner@example.com");
});
