import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Phase 1 runtime coverage: initial subscriptions are created only after
// automatic text-back is active. Checkout is reserved for authenticated
// restarts after the one-time trial has already been used.

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

const customerExperienceContract = await loadTsModule("lib/customer-experience-contract.ts");
const billing = await loadTsModule("lib/billing.ts", {
  "@/lib/customer-experience-contract": customerExperienceContract,
});

const stripeBilling = await loadTsModule("lib/stripe-billing.ts", {
  "node:crypto": await import("node:crypto"),
  "@/lib/env": {
    env: {
      appBaseUrl: "https://www.relay-nw.com",
      stripeSecretKey: "sk_test_example",
      stripeWebhookSecret: "whsec_example",
      stripePriceId: "price_123",
      stripeSetupFeePriceId: "price_setup_150",
    },
  },
  "@/lib/billing": {},
});

function billingRecord(overrides = {}) {
  return {
    ...billing.defaultBillingRecord(),
    ...overrides,
  };
}

function lifecycle(billingOverrides = {}, setupOverrides = {}) {
  return billing.computeBillingLifecycle({
    billing: billingRecord(billingOverrides),
    technicalStatus: "live",
    a2pStatus: "approved",
    smsEnabled: true,
    ...setupOverrides,
  });
}

test("calls working alone cannot start the monthly trial", () => {
  const callsOnly = lifecycle(
    {
      setupFeeStatus: "paid",
      stripeDefaultPaymentMethodId: "pm_1",
    },
    { a2pStatus: "in_progress", smsEnabled: false },
  );
  const textBackActive = lifecycle({
    setupFeeStatus: "paid",
    stripeDefaultPaymentMethodId: "pm_1",
  });

  assert.equal(callsOnly.activationReady, false);
  assert.equal(callsOnly.ownerAction, "finish_setup");
  assert.equal(textBackActive.activationReady, true);
  assert.equal(textBackActive.ownerAction, "wait_for_activation");
});

test("billing lifecycle exposes one safe customer action", () => {
  assert.equal(lifecycle({ setupFeeStatus: "due" }).ownerAction, "pay_setup_fee");
  assert.equal(lifecycle({ setupFeeStatus: "paid" }).ownerAction, "add_payment_method");
  assert.equal(
    lifecycle(
      { setupFeeStatus: "paid", stripeDefaultPaymentMethodId: "pm_1" },
      { a2pStatus: "in_progress", smsEnabled: false },
    ).ownerAction,
    "finish_setup",
  );
  assert.equal(lifecycle({ billingStatus: "trialing" }).ownerAction, "manage_billing");
  assert.equal(lifecycle({ billingStatus: "active" }).ownerAction, "manage_billing");
  assert.equal(lifecycle({ billingStatus: "past_due" }).ownerAction, "update_payment");
  assert.equal(lifecycle({ billingStatus: "canceled" }).ownerAction, "restart_subscription");
  assert.equal(lifecycle({ billingStatus: "comped", billingPolicy: "comped" }).ownerAction, "none");
});

test("subscription Checkout is a restart path, never an initial-trial path", () => {
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord(),
      activationReady: false,
    }),
    { ok: false, reason: "initial_trial_managed_automatically" },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({
        billingStatus: "canceled",
        stripeSubscriptionStatus: "canceled",
        activatedAt: "2026-07-23T00:00:00.000Z",
      }),
      activationReady: true,
    }),
    { ok: true },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({ billingStatus: "trialing" }),
      activationReady: true,
    }),
    { ok: false, reason: "already_active" },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({ billingStatus: "not_started", stripeSubscriptionStatus: "incomplete" }),
      activationReady: true,
    }),
    { ok: false, reason: "subscription_incomplete" },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({ billingStatus: "past_due", stripeSubscriptionStatus: "past_due" }),
      activationReady: true,
    }),
    { ok: false, reason: "past_due" },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({
        billingStatus: "canceled",
        stripeSubscriptionStatus: "canceled",
        activatedAt: "2026-07-23T00:00:00.000Z",
      }),
      activationReady: false,
    }),
    { ok: false, reason: "setup_incomplete" },
  );
});

test("commercial setup and saved-card readiness remain explicit trial gates", () => {
  const due = lifecycle({ setupFeeStatus: "due" });
  const pilotWithoutCard = lifecycle({
    commercialOffer: "founding_pilot",
    billingPolicy: "setup_fee_waived",
    setupFeeStatus: "waived",
  });
  const pilotReady = lifecycle({
    commercialOffer: "founding_pilot",
    billingPolicy: "setup_fee_waived",
    setupFeeStatus: "waived",
    stripeDefaultPaymentMethodId: "pm_pilot",
  });

  assert.equal(due.ownerAction, "pay_setup_fee");
  assert.equal(pilotWithoutCard.ownerAction, "add_payment_method");
  assert.equal(pilotReady.ownerAction, "wait_for_activation");
  assert.match(pilotWithoutCard.summary, /30-day trial/);
});

test("an explicit refund or chargeback overrides a historical first payment", () => {
  assert.equal(billing.isSetupFeeSettled("refunded", "2026-07-01T00:00:00.000Z"), false);
  assert.equal(billing.isSetupFeeSettled("charged_back", "2026-07-01T00:00:00.000Z"), false);
  assert.equal(billing.isSetupFeeSettled("disputed", "2026-07-01T00:00:00.000Z"), false);
  assert.equal(billing.isSetupFeeSettled("partially_refunded", "2026-07-01T00:00:00.000Z"), true);
  assert.equal(billing.isSetupFeeSettled(null, "2026-07-01T00:00:00.000Z"), true);
});

test("setup fee remains separately observable without taking over technical setup", () => {
  const state = lifecycle(
    { setupFeeStatus: "due" },
    { technicalStatus: "setting_up", a2pStatus: "not_started", smsEnabled: false },
  );

  assert.equal(state.ownerAction, "pay_setup_fee");
  assert.equal(state.label, "Setup fee due");
});

test("trialing billing lifecycle does not claim the account is renewing monthly", () => {
  const state = lifecycle({
    billingStatus: "trialing",
    trialEndsAt: "2026-08-01T12:00:00.000Z",
  });

  assert.equal(state.label, "Trial active");
  assert.equal(state.headline, "Trial is active.");
  assert.match(state.summary, /trial is active until Aug 1, 2026/);
  assert.doesNotMatch(state.summary, /renew monthly/);
});

test("scheduled cancellation stays manageable and does not imply service shutdown", () => {
  const state = lifecycle({
    billingStatus: "active",
    cancelAtPeriodEnd: true,
    currentPeriodEnd: "2026-08-01T00:00:00.000Z",
  });

  assert.equal(state.label, "Active until end date");
  assert.equal(state.ownerAction, "manage_billing");
  assert.equal(state.tone, "warn");
  assert.match(state.summary, /scheduled to end/);
  assert.match(state.summary, /keeps catching missed calls/);
});

test("past due and canceled remain visible without disabling call capture", () => {
  const pastDue = lifecycle({ billingStatus: "past_due" });
  const canceled = lifecycle({ billingStatus: "canceled" });

  assert.equal(pastDue.tone, "warn");
  assert.match(pastDue.summary, /Missed-call capture/);
  assert.equal(canceled.tone, "warn");
  assert.match(canceled.summary, /Restart securely in Stripe/);
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
  assert.equal(stripeBilling.mapStripeSubscriptionStatus("paused"), "past_due");
  assert.equal(stripeBilling.mapStripeSubscriptionStatus("incomplete_expired"), "canceled");
  assert.equal(stripeBilling.mapStripeSubscriptionStatus("unexpected"), "not_started");
});

test("stripe webhook signatures must be valid and recent", () => {
  const rawBody = JSON.stringify({ id: "evt_123" });
  const timestamp = 1_800_000_000;
  const secret = "whsec_example";
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const header = `t=${timestamp},v1=${signature}`;

  assert.equal(stripeBilling.verifyStripeWebhookSignature(rawBody, header, secret, timestamp * 1000), true);
  assert.equal(
    stripeBilling.verifyStripeWebhookSignature(
      rawBody,
      `t=${timestamp},v1=${signature},v1=${"0".repeat(64)}`,
      secret,
      timestamp * 1000,
    ),
    true,
  );
  assert.equal(stripeBilling.verifyStripeWebhookSignature(rawBody, header, "wrong_secret", timestamp * 1000), false);
  assert.equal(stripeBilling.verifyStripeWebhookSignature(rawBody, header, secret, (timestamp + 1_000) * 1000), false);
  assert.equal(stripeBilling.verifyStripeWebhookSignature(rawBody, `t=${timestamp},v1=invalid`, secret, timestamp * 1000), false);
});

test("setup-fee truth requires Stripe's exact configured amount and currency", () => {
  const payment = {
    id: "pi_setup",
    customerId: "cus_1",
    paymentMethodId: "pm_1",
    status: "succeeded",
    currency: "usd",
    amount: 15000,
    amountReceived: 15000,
    amountRefunded: 0,
    disputed: false,
    disputeStatus: null,
    livemode: false,
  };

  assert.equal(stripeBilling.setupFeeStateFromPayment(payment, 15000).setupFeeStatus, "paid");
  assert.equal(
    stripeBilling.setupFeeStateFromPayment({ ...payment, currency: "cad" }, 15000).setupFeeStatus,
    "due",
  );
  assert.equal(
    stripeBilling.setupFeeStateFromPayment({ ...payment, amount: 100, amountReceived: 100 }, 15000).setupFeeStatus,
    "due",
  );
});

test("setup fee checkout creates a customer when collecting a new card", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      async json() {
        return { id: "cs_setup_123", url: "https://checkout.stripe.test/setup" };
      },
    };
  };

  try {
    const checkout = await stripeBilling.createStripeSetupFeeCheckoutSession({
      accountId: "acct_123",
      accountSlug: "demo-plumbing",
      ownerEmail: "owner@example.com",
      stripeCustomerId: null,
      setupFeeCents: 15000,
      idempotencyKey: "idem_setup",
    });
    const params = new URLSearchParams(calls[0].init.body);

    assert.deepEqual(checkout, { id: "cs_setup_123", url: "https://checkout.stripe.test/setup" });
    assert.equal(calls.length, 1);
    assert.equal(params.get("mode"), "payment");
    assert.equal(params.get("customer_email"), "owner@example.com");
    assert.equal(params.get("customer_creation"), "always");
    assert.equal(params.get("payment_intent_data[setup_future_usage]"), "off_session");
    assert.equal(params.get("payment_method_types[0]"), "card");
    assert.equal(
      params.get("consent_collection[payment_method_reuse_agreement][position]"),
      "auto",
    );
    assert.match(params.get("custom_text[submit][message]"), /saved securely in Stripe/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("setup fee Checkout refuses local pricing drift", async () => {
  await assert.rejects(
    stripeBilling.createStripeSetupFeeCheckoutSession({
      accountId: "acct_123",
      accountSlug: "demo-plumbing",
      ownerEmail: "owner@example.com",
      stripeCustomerId: null,
      setupFeeCents: 100,
      idempotencyKey: "idem_wrong_setup_fee",
    }),
    /exactly \$150/,
  );
});

test("founding-pilot card collection uses Stripe setup mode and charges nothing", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      async json() {
        return { id: "cs_pilot_card", url: "https://checkout.stripe.test/card" };
      },
    };
  };

  try {
    await stripeBilling.createStripePaymentMethodCheckoutSession({
      accountId: "acct_pilot",
      accountSlug: "pilot-plumbing",
      ownerEmail: "pilot@example.com",
      stripeCustomerId: null,
      trialDays: 30,
      idempotencyKey: "pilot-card-key",
    });
    const params = new URLSearchParams(calls[0].init.body);

    assert.equal(params.get("mode"), "setup");
    assert.equal(params.get("currency"), "usd");
    assert.equal(params.get("customer_creation"), "always");
    assert.equal(params.get("payment_method_types[0]"), "card");
    assert.equal(params.has("line_items[0][price]"), false);
    assert.equal(params.has("amount"), false);
    assert.match(params.get("custom_text[submit][message]"), /Nothing is charged now/);
    assert.match(params.get("custom_text[submit][message]"), /30-day trial/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("delayed trial creation is Stripe-owned, scoped, and idempotent", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      async json() {
        return {
          id: "sub_trial",
          customer: "cus_123",
          status: "trialing",
          trial_start: 1_800_000_000,
          trial_end: 1_801_209_600,
          livemode: false,
          metadata: { account_id: "acct_123" },
          items: { data: [{ price: { id: "price_123" } }] },
        };
      },
    };
  };

  try {
    const subscription = await stripeBilling.createStripeTrialSubscription({
      accountId: "acct_123",
      accountSlug: "demo",
      commercialOffer: "standard",
      customerId: "cus_123",
      defaultPaymentMethodId: "pm_123",
      trialDays: 14,
      idempotencyKey: "relay-trial-activation:acct_123:initial:standard:v1",
    });
    const params = new URLSearchParams(calls[0].init.body);

    assert.equal(calls[0].url, "https://api.stripe.com/v1/subscriptions");
    assert.equal(calls[0].init.headers["Idempotency-Key"], "relay-trial-activation:acct_123:initial:standard:v1");
    assert.equal(params.get("trial_period_days"), "14");
    assert.equal(params.get("default_payment_method"), "pm_123");
    assert.equal(params.get("payment_behavior"), "default_incomplete");
    assert.equal(params.get("trial_settings[end_behavior][missing_payment_method]"), "cancel");
    assert.equal(params.get("metadata[account_id]"), "acct_123");
    assert.equal(params.get("metadata[activation_contract]"), "delayed-text-back-v1");
    assert.equal(params.has("trial_end"), false);
    assert.equal(subscription.status, "trialing");
    assert.equal(subscription.metadataAccountId, "acct_123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("PaymentIntent retrieval expands and preserves Stripe's dispute outcome", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";

  globalThis.fetch = async (url) => {
    requestUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        id: "pi_setup_123",
        customer: "cus_123",
        payment_method: "pm_123",
        status: "succeeded",
        amount: 15000,
        amount_received: 15000,
        latest_charge: {
          amount_refunded: 0,
          disputed: true,
          dispute: { status: "lost" },
        },
      }),
    };
  };

  try {
    const payment = await stripeBilling.retrieveStripePaymentIntent("pi_setup_123");
    assert.equal(payment.disputed, true);
    assert.equal(payment.disputeStatus, "lost");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    new URL(requestUrl).searchParams.get("expand[]"),
    "latest_charge.dispute",
  );
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

test("Stripe subscription snapshots never establish paid or guarantee dates", () => {
  const update = stripeBilling.billingUpdateFromSubscription(
    "acct_123",
    {
      id: "sub_123",
      customerId: "cus_123",
      priceId: "price_123",
      status: "active",
      trialStartsAt: null,
      trialEndsAt: null,
      currentPeriodEnd: "2026-08-17T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    },
    { nowIso: "2026-07-17T00:00:00.000Z" },
  );

  assert.equal(update.billingStatus, "active");
  assert.equal(update.onboardingStatus, undefined);
  assert.equal(update.activatedAt, null);
  assert.equal(update.firstPaidAt, undefined);
  assert.equal(update.guaranteeEndsAt, undefined);
});

test("only a positive paid invoice uses Stripe's paid timestamp for guarantee dates", () => {
  assert.deepEqual(
    stripeBilling.billingDatesFromPaidInvoice({
      paid: true,
      status: "paid",
      amount_paid: 9900,
      status_transitions: { paid_at: 1_800_000_000 },
    }),
    {
      firstPaidAt: "2027-01-15T08:00:00.000Z",
      guaranteeEndsAt: "2027-02-14T08:00:00.000Z",
    },
  );
  assert.equal(
    stripeBilling.billingDatesFromPaidInvoice({
      paid: true,
      status: "paid",
      amount_paid: 0,
      status_transitions: { paid_at: 1_800_000_000 },
    }),
    null,
  );
  assert.equal(
    stripeBilling.billingDatesFromPaidInvoice({
      paid: true,
      status: "paid",
      amount_paid: 9900,
      status_transitions: {},
    }),
    null,
  );
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

test("Stripe Checkout creates the customer-owned subscription without an app trial", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  let requestUrl = "";

  globalThis.fetch = async (url, init) => {
    requestUrl = String(url);
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
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const params = new URLSearchParams(requestBody);
  assert.equal(requestUrl, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(params.has("subscription_data[trial_period_days]"), false);
  assert.equal(params.get("metadata[account_id]"), "acct_123");
  assert.equal(params.get("customer_email"), "owner@example.com");
  assert.equal(params.get("success_url"), "https://www.relay-nw.com/settings?billing=success#billing");
  assert.equal(params.get("cancel_url"), "https://www.relay-nw.com/settings?billing=canceled#billing");
});

test("existing Stripe Checkout session lookup exposes reuse state", async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = "";

  globalThis.fetch = async (url) => {
    requestUrl = String(url);
    return {
      ok: true,
      json: async () => ({
        id: "cs_existing",
        url: "https://checkout.stripe.test/existing",
        status: "open",
        payment_status: "unpaid",
      }),
    };
  };

  try {
    assert.deepEqual(
      await stripeBilling.retrieveStripeCheckoutSession("cs_existing"),
      {
        id: "cs_existing",
        url: "https://checkout.stripe.test/existing",
        status: "open",
        paymentStatus: "unpaid",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(
    requestUrl,
    "https://api.stripe.com/v1/checkout/sessions/cs_existing",
  );
});
