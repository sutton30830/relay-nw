import assert from "node:assert/strict";
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
  const script = new vm.Script(
    `(function(require, module, exports) { ${compiled}\n})`,
    { filename: path },
  );
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

const contract = await loadTsModule("lib/customer-experience-contract.ts");
const billingModule = await loadTsModule("lib/billing.ts", {
  "@/lib/customer-experience-contract": contract,
});

function billingRecord(overrides = {}) {
  return {
    ...billingModule.defaultBillingRecord(),
    setupFeeStatus: "paid",
    stripeCustomerId: "cus_1",
    stripeDefaultPaymentMethodId: "pm_1",
    ...overrides,
  };
}

function subscription(overrides = {}) {
  return {
    id: "sub_trial",
    customerId: "cus_1",
    status: "trialing",
    priceId: "price_99",
    trialStartsAt: "2026-07-23T00:00:00.000Z",
    trialEndsAt: "2026-08-06T00:00:00.000Z",
    currentPeriodEnd: "2026-08-06T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    metadataAccountId: "acct_1",
    livemode: false,
    ...overrides,
  };
}

async function runActivation({
  accountBilling = billingRecord(),
  technicalStatus = "live",
  operationalStatus = "active",
  a2pStatus = "approved",
  smsEnabled = true,
  blockedBy = "none",
  customer = { id: "cus_1", defaultPaymentMethodId: "pm_1", livemode: false },
  subscriptions = [],
  createdSubscription = subscription(),
  createImplementation = null,
  updateImplementation = null,
} = {}) {
  const calls = {
    customerLookups: [],
    paymentLookups: [],
    setupLookups: [],
    customerUpdates: [],
    subscriptionLists: [],
    creates: [],
    billingUpdates: [],
    audits: [],
  };

  const stripeMocks = {
    assertStripeObjectMode: (livemode, label) => {
      if (livemode !== false) throw new Error(`${label} belongs to the wrong Stripe mode.`);
    },
    billingUpdateFromSubscription: (accountId, value) => ({
      accountId,
      billingStatus: value.status === "trialing" ? "trialing" : value.status,
      stripeCustomerId: value.customerId,
      stripeSubscriptionId: value.id,
      stripePriceId: value.priceId,
      stripeSubscriptionStatus: value.status,
      trialEndsAt: value.trialEndsAt,
      currentPeriodEnd: value.currentPeriodEnd,
      cancelAtPeriodEnd: value.cancelAtPeriodEnd,
      activatedAt: value.trialStartsAt,
      billingAttentionSince: null,
    }),
    retrieveStripeCustomerBillingProfile: async (customerId) => {
      calls.customerLookups.push(customerId);
      return customer;
    },
    retrieveStripePaymentIntent: async (paymentIntentId) => {
      calls.paymentLookups.push(paymentIntentId);
      throw new Error("unexpected PaymentIntent lookup");
    },
    retrieveStripeSetupIntent: async (setupIntentId) => {
      calls.setupLookups.push(setupIntentId);
      throw new Error("unexpected SetupIntent lookup");
    },
    setStripeCustomerDefaultPaymentMethod: async (input) => {
      calls.customerUpdates.push(input);
      return customer;
    },
    listStripeSubscriptionsForCustomer: async (customerId) => {
      calls.subscriptionLists.push(customerId);
      return typeof subscriptions === "function" ? subscriptions() : subscriptions;
    },
    createStripeTrialSubscription: async (input) => {
      calls.creates.push(input);
      if (createImplementation) return createImplementation(input, calls.creates.length);
      return createdSubscription;
    },
  };

  const module = await loadTsModule("lib/billing-activation.ts", {
    "@/lib/customer-experience-contract": contract,
    "@/lib/billing": billingModule,
    "@/lib/stripe-billing": stripeMocks,
    "@/lib/supabase": {
      getAccountBillingRecord: async () => accountBilling,
      getAccountTechnicalSetupStatus: async () => technicalStatus,
      getAccountOperationalStatus: async () => operationalStatus,
      getA2pRegistrationStatus: async () => a2pStatus,
      getAccountOpsBlocker: async () => ({
        blockedBy,
        blockerNote: blockedBy === "none" ? null : "Explicit test blocker",
        blockedSince: blockedBy === "none" ? null : "2026-07-23T00:00:00.000Z",
      }),
      getAccountConfigByAccountId: async (accountId) => ({
        accountId,
        accountSlug: "demo",
        smsEnabled,
      }),
      updateAccountBillingRecord: async (accountId, update) => {
        calls.billingUpdates.push({ accountId, update });
        if (updateImplementation) await updateImplementation(accountId, update, calls.billingUpdates.length);
      },
      recordAccountAuditEvents: async (input) => {
        calls.audits.push(input);
      },
    },
  });

  return {
    result: await module.activateStripeTrialForAccount("acct_1"),
    calls,
  };
}

test("calls live while texting is pending never reaches Stripe", async () => {
  const { result, calls } = await runActivation({
    a2pStatus: "in_progress",
    smsEnabled: false,
  });

  assert.deepEqual(result, {
    status: "not_eligible",
    reason: "automatic_text_back_not_active",
  });
  assert.deepEqual(calls.customerLookups, []);
  assert.deepEqual(calls.creates, []);
});

test("A2P approval without automatic text-back does not consume trial time", async () => {
  const { result, calls } = await runActivation({ smsEnabled: false });
  assert.equal(result.status, "not_eligible");
  assert.deepEqual(calls.creates, []);
});

test("paused and closed accounts cannot start a Stripe trial", async () => {
  for (const operationalStatus of ["paused", "archived"]) {
    const { result, calls } = await runActivation({ operationalStatus });
    assert.deepEqual(result, {
      status: "not_eligible",
      reason: operationalStatus === "archived" ? "account_closed" : "account_paused",
    });
    assert.deepEqual(calls.customerLookups, []);
    assert.deepEqual(calls.creates, []);
  }
});

test("an explicit Operations blocker prevents trial activation", async () => {
  for (const blockedBy of ["relay", "customer", "carrier"]) {
    const { result, calls } = await runActivation({ blockedBy });

    assert.deepEqual(result, {
      status: "not_eligible",
      reason: `operations_blocked_by_${blockedBy}`,
    });
    assert.deepEqual(calls.customerLookups, []);
    assert.deepEqual(calls.subscriptionLists, []);
    assert.deepEqual(calls.creates, []);
  }
});

test("standard setup fee is required before Stripe trial activation", async () => {
  const { result, calls } = await runActivation({
    accountBilling: billingRecord({
      setupFeeStatus: "due",
      stripeDefaultPaymentMethodId: null,
    }),
  });
  assert.deepEqual(result, {
    status: "setup_fee_required",
    reason: "setup_fee_not_settled",
  });
  assert.deepEqual(calls.customerLookups, []);
});

test("a waived pilot still needs a Stripe-owned payment method", async () => {
  const { result, calls } = await runActivation({
    accountBilling: billingRecord({
      commercialOffer: "founding_pilot",
      billingPolicy: "setup_fee_waived",
      setupFeeStatus: "waived",
      stripeDefaultPaymentMethodId: null,
    }),
    customer: { id: "cus_1", defaultPaymentMethodId: null, livemode: false },
  });

  assert.deepEqual(result, {
    status: "payment_method_required",
    reason: "stripe_default_payment_method_missing",
  });
  assert.deepEqual(calls.creates, []);
});

test("standard activation creates an idempotent 14-day Stripe trial", async () => {
  const { result, calls } = await runActivation();

  assert.equal(result.status, "created");
  assert.equal(calls.creates.length, 1);
  assert.equal(calls.creates[0].trialDays, 14);
  assert.equal(calls.creates[0].commercialOffer, "standard");
  assert.equal(
    calls.creates[0].idempotencyKey,
    "relay-trial-activation:acct_1:initial:standard:v1",
  );
  assert.ok(calls.billingUpdates.some(({ update }) => update.billingStatus === "trialing"));
});

test("founding-pilot activation creates a 30-day Stripe trial", async () => {
  const { result, calls } = await runActivation({
    accountBilling: billingRecord({
      commercialOffer: "founding_pilot",
      billingPolicy: "setup_fee_waived",
      setupFeeStatus: "waived",
    }),
    createdSubscription: subscription({
      trialEndsAt: "2026-08-22T00:00:00.000Z",
    }),
  });

  assert.equal(result.status, "created");
  assert.equal(calls.creates[0].trialDays, 30);
  assert.equal(calls.creates[0].commercialOffer, "founding_pilot");
});

test("a matching nonterminal Stripe subscription is synchronized instead of duplicated", async () => {
  const existing = subscription();
  const { result, calls } = await runActivation({
    subscriptions: [existing],
  });

  assert.deepEqual(result, {
    status: "already_started",
    subscriptionId: "sub_trial",
    trialEndsAt: existing.trialEndsAt,
  });
  assert.deepEqual(calls.creates, []);
  assert.ok(calls.billingUpdates.some(({ update }) => update.stripeSubscriptionId === "sub_trial"));
});

test("an unrelated nonterminal subscription blocks tenant-unsafe activation", async () => {
  const { result, calls } = await runActivation({
    subscriptions: [subscription({
      id: "sub_other",
      metadataAccountId: "acct_other",
    })],
  });

  assert.deepEqual(result, {
    status: "conflicting_subscription",
    reason: "stripe_customer_has_trialing_subscription",
  });
  assert.deepEqual(calls.creates, []);
});

test("ambiguous create retry reuses the exact Stripe idempotency key", async () => {
  let attempt = 0;
  const attemptedKeys = [];
  const createImplementation = async (input) => {
    attemptedKeys.push(input.idempotencyKey);
    attempt += 1;
    if (attempt === 1) throw new Error("connection closed after request");
    return subscription();
  };

  await assert.rejects(
    runActivation({ createImplementation }),
    /connection closed after request/,
  );
  const second = await runActivation({ createImplementation });

  assert.equal(second.result.status, "created");
  assert.deepEqual(attemptedKeys, [
    "relay-trial-activation:acct_1:initial:standard:v1",
    "relay-trial-activation:acct_1:initial:standard:v1",
  ]);
});

test("retry after a local write failure recovers the Stripe subscription", async () => {
  let listed = [];
  let failWrite = true;
  const created = subscription();

  await assert.rejects(
    runActivation({
      subscriptions: () => listed,
      createdSubscription: created,
      updateImplementation: async (_accountId, update) => {
        if (update.billingStatus === "trialing" && failWrite) {
          listed = [created];
          failWrite = false;
          throw new Error("database unavailable");
        }
      },
    }),
    /database unavailable/,
  );

  const retry = await runActivation({ subscriptions: listed });
  assert.equal(retry.result.status, "already_started");
  assert.deepEqual(retry.calls.creates, []);
});

test("an already-used trial cannot be granted again after cancellation", async () => {
  const { result, calls } = await runActivation({
    accountBilling: billingRecord({
      billingStatus: "canceled",
      stripeSubscriptionStatus: "canceled",
      activatedAt: "2026-07-01T00:00:00.000Z",
    }),
  });

  assert.deepEqual(result, {
    status: "restart_required",
    reason: "initial_trial_already_used",
  });
  assert.deepEqual(calls.creates, []);
});

test("Stripe test/live mismatch fails closed before subscription creation", async () => {
  await assert.rejects(
    runActivation({
      customer: {
        id: "cus_live",
        defaultPaymentMethodId: "pm_live",
        livemode: true,
      },
    }),
    /wrong Stripe mode/,
  );
});
