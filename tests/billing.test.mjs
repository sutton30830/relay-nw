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
  "@/lib/customer-experience-contract": {
    canStartMonthlyBilling: (status) => status === "live",
  },
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
    billingStatus: "not_started",
    billingPolicy: "standard",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripePriceId: null,
    trialEndsAt: null,
    billingUpdatedAt: null,
    ...overrides,
  };
}

test("technical status alone determines whether billing can start", () => {
  const live = billing.computeBillingLifecycle({
    billing: billingRecord(),
    technicalStatus: "live",
  });
  const waiting = billing.computeBillingLifecycle({
    billing: billingRecord(),
    technicalStatus: "waiting_for_forwarding",
  });

  assert.equal(live.activationReady, true);
  assert.equal(live.ownerAction, "start_billing");
  assert.equal(waiting.activationReady, false);
  assert.equal(waiting.ownerAction, "finish_setup");
});

test("every billing status has one owner action", () => {
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
      technicalStatus: "live",
    });

    assert.equal(state.ownerAction, ownerAction);
  }
});

test("checkout eligibility allows only not started or fully canceled accounts", () => {
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({ billing: billingRecord(), technicalStatus: "live" }),
    { ok: true },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({ billingStatus: "canceled", stripeSubscriptionStatus: "canceled" }),
      technicalStatus: "live",
    }),
    { ok: true },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({ billingStatus: "trialing", stripeSubscriptionId: null }),
      technicalStatus: "live",
    }),
    { ok: true },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({ billingStatus: "not_started", stripeSubscriptionStatus: "incomplete" }),
      technicalStatus: "live",
    }),
    { ok: false, reason: "subscription_incomplete" },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord({ billingStatus: "past_due", stripeSubscriptionStatus: "past_due" }),
      technicalStatus: "live",
    }),
    { ok: false, reason: "past_due" },
  );
  assert.deepEqual(
    billing.getBillingCheckoutEligibility({
      billing: billingRecord(),
      technicalStatus: "waiting_for_forwarding",
    }),
    { ok: false, reason: "setup_incomplete" },
  );
});

test("setup fee state does not gate monthly billing after call capture is live", () => {
  const due = billing.getBillingCheckoutEligibility({
    billing: billingRecord({ setupFeeStatus: "due" }),
    technicalStatus: "live",
  });
  const waived = billing.getBillingCheckoutEligibility({
    billing: billingRecord({ setupFeeStatus: "waived" }),
    technicalStatus: "live",
  });

  assert.deepEqual(due, { ok: true });
  assert.deepEqual(waived, { ok: true });
});

test("an explicit refund or chargeback overrides a historical first payment", () => {
  assert.equal(billing.isSetupFeeSettled("refunded", "2026-07-01T00:00:00.000Z"), false);
  assert.equal(billing.isSetupFeeSettled("charged_back", "2026-07-01T00:00:00.000Z"), false);
  assert.equal(billing.isSetupFeeSettled("disputed", "2026-07-01T00:00:00.000Z"), false);
  assert.equal(billing.isSetupFeeSettled("partially_refunded", "2026-07-01T00:00:00.000Z"), true);
  assert.equal(billing.isSetupFeeSettled(null, "2026-07-01T00:00:00.000Z"), true);
});

test("setup fee remains separately observable without taking over technical setup", () => {
  const lifecycle = billing.computeBillingLifecycle({
    billing: billingRecord({ setupFeeStatus: "due" }),
    technicalStatus: "setting_up",
  });

  assert.equal(lifecycle.ownerAction, "finish_setup");
  assert.equal(lifecycle.label, "Setup first");
});

test("trialing billing lifecycle does not claim the account is renewing monthly", () => {
  const state = billing.computeBillingLifecycle({
    billing: billingRecord({
      billingStatus: "trialing",
      trialEndsAt: "2026-08-01T12:00:00.000Z",
    }),
    technicalStatus: "live",
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
    technicalStatus: "live",
  });

  assert.equal(state.label, "Active until end date");
  assert.equal(state.ownerAction, "manage_billing");
  assert.equal(state.tone, "warn");
  assert.match(state.summary, /canceled/);
  assert.match(state.summary, /keeps catching missed calls/);
});

test("past due and canceled remain visible without disabling call capture", () => {
  for (const billingStatus of ["past_due", "canceled"]) {
    const state = billing.computeBillingLifecycle({
      billing: billingRecord({ billingStatus }),
      technicalStatus: "live",
    });

    assert.equal(state.tone, "warn");
    assert.match(state.summary, /Relay|Missed-call capture/);
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
  assert.equal(stripeBilling.verifyStripeWebhookSignature(rawBody, header, "wrong_secret", timestamp * 1000), false);
  assert.equal(stripeBilling.verifyStripeWebhookSignature(rawBody, header, secret, (timestamp + 1_000) * 1000), false);
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
      trialEndsAt: null,
      currentPeriodEnd: "2026-08-17T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    },
    { nowIso: "2026-07-17T00:00:00.000Z" },
  );

  assert.equal(update.billingStatus, "active");
  assert.equal(update.onboardingStatus, undefined);
  assert.equal(update.activatedAt, undefined);
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
