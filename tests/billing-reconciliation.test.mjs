import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadTsModule(path, mocks) {
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

const stripeBilling = await loadTsModule("lib/stripe-billing.ts", {
  "node:crypto": await import("node:crypto"),
  "@/lib/env": {
    env: {
      appBaseUrl: "https://www.relay-nw.com",
      stripeSecretKey: "sk_test_example",
      stripePriceId: "price_123",
      stripeSetupFeePriceId: "price_setup_150",
    },
  },
  "@/lib/billing": {},
});

function account(overrides = {}) {
  return {
    accountId: "acct_1",
    setupFeeCents: 15000,
    setupFeeCheckoutSessionId: null,
    setupFeePaymentIntentId: "pi_setup_1",
    setupFeeStatus: "paid",
    setupFeeDisputeStatus: null,
    setupFeeRefundedAt: null,
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: null,
    stripeSetupIntentId: null,
    billingSetupCheckoutSessionId: null,
    stripeDefaultPaymentMethodId: "pm_1",
    ...overrides,
  };
}

function payment(overrides = {}) {
  return {
    id: "pi_setup_1",
    customerId: "cus_1",
    paymentMethodId: "pm_1",
    metadataAccountId: "acct_1",
    status: "succeeded",
    currency: "usd",
    amount: 15000,
    amountReceived: 15000,
    amountRefunded: 0,
    disputed: false,
    disputeStatus: null,
    livemode: false,
    ...overrides,
  };
}

async function reconcile(inputAccount, paymentSnapshot) {
  const updates = [];
  const module = await loadTsModule("lib/billing-reconciliation.ts", {
    "@/lib/stripe-billing": {
      ...stripeBilling,
      retrieveStripePaymentIntent: async () => paymentSnapshot,
      retrieveStripeSetupCheckoutSession: async () => {
        throw new Error("unexpected setup Checkout lookup");
      },
      retrieveStripeSubscription: async () => {
        throw new Error("unexpected subscription lookup");
      },
      retrieveStripeSetupIntent: async () => {
        throw new Error("unexpected SetupIntent lookup");
      },
      retrieveStripeCustomerBillingProfile: async () => ({
        id: "cus_1",
        defaultPaymentMethodId: "pm_1",
        livemode: false,
      }),
      setStripeCustomerDefaultPaymentMethod: async () => {
        throw new Error("unexpected customer update");
      },
    },
    "@/lib/supabase": {
      updateAccountBillingRecord: async (accountId, update) => {
        updates.push({ accountId, update });
      },
    },
  });

  const result = await module.reconcileStripeBillingAccount(inputAccount);
  return { result, updates };
}

test("reconciliation preserves charged-back truth without an explicit Stripe resolution", async () => {
  const { result, updates } = await reconcile(
    account({
      setupFeeStatus: "charged_back",
      setupFeeDisputeStatus: "lost",
      setupFeeRefundedAt: "2026-07-01T00:00:00.000Z",
    }),
    payment(),
  );

  assert.deepEqual(result, {
    setupFeeChecked: true,
    paymentMethodChecked: true,
    subscriptionChecked: false,
  });
  const setupUpdate = updates.find(({ update }) => update.setupFeeStatus);
  assert.equal(setupUpdate.update.setupFeeStatus, "charged_back");
  assert.equal(setupUpdate.update.setupFeeDisputeStatus, "lost");
  assert.equal(setupUpdate.update.setupFeeRefundedAt, "2026-07-01T00:00:00.000Z");
});

test("reconciliation uses Stripe's explicit lost dispute outcome", async () => {
  const { updates } = await reconcile(
    account(),
    payment({ disputed: true, disputeStatus: "lost" }),
  );

  const setupUpdate = updates.find(({ update }) => update.setupFeeStatus);
  assert.equal(setupUpdate.update.setupFeeStatus, "charged_back");
  assert.equal(setupUpdate.update.setupFeeDisputeStatus, "lost");
  assert.match(setupUpdate.update.setupFeeRefundedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("reconciliation preserves an unresolved dispute when Stripe omits its outcome", async () => {
  const { updates } = await reconcile(
    account({
      setupFeeStatus: "disputed",
      setupFeeDisputeStatus: "under_review",
    }),
    payment(),
  );

  const setupUpdate = updates.find(({ update }) => update.setupFeeStatus);
  assert.equal(setupUpdate.update.setupFeeStatus, "disputed");
  assert.equal(setupUpdate.update.setupFeeDisputeStatus, "under_review");
});

test("reconciliation clears a disputed state only after Stripe reports it won", async () => {
  const { updates } = await reconcile(
    account({
      setupFeeStatus: "disputed",
      setupFeeDisputeStatus: "under_review",
    }),
    payment({ disputed: true, disputeStatus: "won" }),
  );

  const setupUpdate = updates.find(({ update }) => update.setupFeeStatus);
  assert.equal(setupUpdate.update.setupFeeStatus, "paid");
  assert.equal(setupUpdate.update.setupFeeDisputeStatus, "won");
});
