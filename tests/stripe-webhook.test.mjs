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

  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

const realStripeBilling = await loadTsModule("lib/stripe-billing.ts", {
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

function subscription(overrides = {}) {
  return {
    id: "sub_1",
    customerId: "cus_1",
    status: "active",
    priceId: "price_123",
    trialStartsAt: null,
    trialEndsAt: null,
    currentPeriodEnd: "2026-08-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    metadataAccountId: "acct_1",
    livemode: false,
    ...overrides,
  };
}

function stripeEvent(type, object, overrides = {}) {
  return {
    id: overrides.id ?? `evt_${type.replaceAll(".", "_")}`,
    type,
    created: overrides.created ?? 1_800_000_000,
    livemode: overrides.livemode ?? false,
    data: { object },
  };
}

function invoiceObject(overrides = {}) {
  return {
    id: "in_1",
    customer: "cus_1",
    subscription: "sub_1",
    paid: false,
    status: "open",
    ...overrides,
  };
}

async function runWebhook({
  event = stripeEvent("customer.subscription.updated", {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    metadata: { account_id: "acct_1" },
  }),
  claim = { status: "claimed", attemptCount: 1 },
  claimError = null,
  subscriptionSnapshot = subscription(),
  paymentSnapshot = {
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
  },
  setupIntentSnapshot = {
    id: "seti_1",
    customerId: "cus_1",
    paymentMethodId: "pm_1",
    metadataAccountId: "acct_1",
    status: "succeeded",
    livemode: false,
  },
  customerSnapshot = {
    id: "cus_1",
    defaultPaymentMethodId: "pm_1",
    livemode: false,
  },
  subscriptionError = null,
  subscriptionAccountId = "acct_1",
  customerAccountId = "acct_1",
  paymentIntentAccountId = null,
  metadataAccountExists = true,
  updateError = null,
  emailError = null,
  ownerEmailError = null,
  accountConfigError = null,
  existingBilling = {
    billingAttentionSince: null,
    cancelAtPeriodEnd: false,
    stripeSubscriptionId: "sub_1",
    setupFeePaymentIntentId: "pi_setup_1",
    setupFeeCents: 15000,
    setupFeeStatus: "paid",
    setupFeeDisputeStatus: null,
    setupFeeRefundedAt: null,
    stripeDefaultPaymentMethodId: null,
  },
  stripeSecretKey = "sk_test_example",
} = {}) {
  const calls = {
    claims: [],
    resolvedSubscriptions: [],
    resolvedCustomers: [],
    resolvedPaymentIntents: [],
    accountExists: [],
    retrievedSubscriptions: [],
    retrievedPayments: [],
    retrievedSetupIntents: [],
    retrievedCustomers: [],
    customerUpdates: [],
    updates: [],
    processed: [],
    ignored: [],
    failed: [],
    emails: [],
    ownerEmails: [],
    accountConfigLookups: [],
    billingLookups: [],
  };

  const { POST } = await loadTsModule("app/api/stripe/webhook/route.ts", {
    "@/lib/env": {
      env: {
        appBaseUrl: "https://www.relay-nw.com",
        stripeSecretKey,
        stripeWebhookSecret: "whsec_example",
        stripePriceId: "price_123",
      },
    },
    "@/lib/email": {
      notifyAdminOperationalIssue: async (input) => {
        calls.emails.push(input);
        if (emailError) throw emailError;
        return { sent: true };
      },
      notifyOwnerBillingPaymentFailed: async (input) => {
        calls.ownerEmails.push({ type: "payment_failed", input });
        if (ownerEmailError) throw ownerEmailError;
        return { sent: true };
      },
      notifyOwnerBillingRecovered: async (input) => {
        calls.ownerEmails.push({ type: "billing_recovered", input });
        if (ownerEmailError) throw ownerEmailError;
        return { sent: true };
      },
      notifyOwnerSubscriptionScheduledToEnd: async (input) => {
        calls.ownerEmails.push({ type: "subscription_scheduled_to_end", input });
        if (ownerEmailError) throw ownerEmailError;
        return { sent: true };
      },
      notifyOwnerTrialEnding: async (input) => {
        calls.ownerEmails.push({ type: "trial_ending", input });
        if (ownerEmailError) throw ownerEmailError;
        return { sent: true };
      },
    },
    "@/lib/stripe-billing": {
      ...realStripeBilling,
      assertStripeWebhookConfigured: () => {},
      verifyStripeWebhookSignature: () => true,
      expectedStripeLivemode: () => stripeSecretKey.startsWith("sk_live_"),
      retrieveStripeSubscription: async (stripeSubscriptionId) => {
        calls.retrievedSubscriptions.push(stripeSubscriptionId);
        if (subscriptionError) throw subscriptionError;
        return subscriptionSnapshot;
      },
      retrieveStripePaymentIntent: async (paymentIntentId) => {
        calls.retrievedPayments.push(paymentIntentId);
        return {
          paymentMethodId: null,
          disputeStatus: null,
          currency: "usd",
          livemode: false,
          ...paymentSnapshot,
          id: paymentIntentId,
        };
      },
      retrieveStripeSetupIntent: async (setupIntentId) => {
        calls.retrievedSetupIntents.push(setupIntentId);
        return { ...setupIntentSnapshot, id: setupIntentId };
      },
      retrieveStripeCustomerBillingProfile: async (customerId) => {
        calls.retrievedCustomers.push(customerId);
        return { ...customerSnapshot, id: customerId };
      },
      setStripeCustomerDefaultPaymentMethod: async (input) => {
        calls.customerUpdates.push(input);
        return {
          ...customerSnapshot,
          id: input.customerId,
          defaultPaymentMethodId: input.paymentMethodId,
        };
      },
    },
    "@/lib/supabase": {
      claimStripeEvent: async (input) => {
        calls.claims.push(input);
        if (claimError) throw claimError;
        return claim;
      },
      resolveAccountIdByStripeSubscriptionId: async (stripeSubscriptionId) => {
        calls.resolvedSubscriptions.push(stripeSubscriptionId);
        return subscriptionAccountId;
      },
      resolveAccountIdByStripeCustomerId: async (stripeCustomerId) => {
        calls.resolvedCustomers.push(stripeCustomerId);
        return customerAccountId;
      },
      resolveAccountIdBySetupFeePaymentIntentId: async (paymentIntentId) => {
        calls.resolvedPaymentIntents.push(paymentIntentId);
        return paymentIntentAccountId;
      },
      accountExists: async (accountId) => {
        calls.accountExists.push(accountId);
        return metadataAccountExists;
      },
      getAccountBillingRecord: async (accountId) => {
        calls.billingLookups.push(accountId);
        return existingBilling;
      },
      getAccountConfigByAccountId: async (accountId) => {
        calls.accountConfigLookups.push(accountId);
        if (accountConfigError) throw accountConfigError;
        return {
          accountId,
          accountSlug: "demo",
          businessName: "Demo Plumbing",
          ownerEmail: "owner@example.com",
          callMode: "forwarding",
          smsEnabled: true,
          intakeUrl: "https://www.relay-nw.com/intake",
          schedulingUrl: "",
          smsTemplate: null,
          quickReplyTemplates: null,
          missedCallVoiceMessage: null,
          missedCallVoiceName: "Polly.Joanna-Neural",
          missedCallGreetingAudioUrl: null,
          voicemailMaxSeconds: 60,
          dialTimeoutSeconds: 18,
          missedCallSmsCooldownHours: 24,
          voicemailTranscriptionEnabled: true,
          twilioPhoneNumber: "+15551234567",
          ownerPhoneNumber: "+12065550123",
        };
      },
      updateAccountBillingRecord: async (accountId, update) => {
        calls.updates.push({ accountId, update });
        if (updateError) throw updateError;
      },
      markStripeEventProcessed: async (input) => calls.processed.push(input),
      markStripeEventIgnored: async (input) => calls.ignored.push(input),
      markStripeEventFailed: async (input) => calls.failed.push(input),
    },
  });

  const response = await POST(new Request("http://localhost:3000/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=test" },
    body: JSON.stringify(event),
  }));
  const body = await response.json();

  return { response, body, calls };
}

test("exact Stripe event replay is acknowledged and skipped", async () => {
  const { response, body, calls } = await runWebhook({
    claim: { status: "duplicate", processingStatus: "processed" },
  });

  assert.equal(response.status, 200);
  assert.equal(body.duplicate, true);
  assert.deepEqual(calls.updates, []);
  assert.deepEqual(calls.processed, []);
});

test("paid setup-fee Checkout marks only the setup fee as paid", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("checkout.session.completed", {
      id: "cs_setup_fee_1",
      mode: "payment",
      customer: "cus_1",
      payment_intent: "pi_setup_1",
      payment_status: "paid",
      metadata: { account_id: "acct_1", charge_type: "setup_fee" },
    }),
    subscriptionAccountId: null,
    customerAccountId: "acct_1",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.updates, [
    {
      accountId: "acct_1",
      update: {
        stripeCustomerId: "cus_1",
        setupFeeStatus: "paid",
        setupFeeCheckoutSessionId: "cs_setup_fee_1",
        setupFeePaymentIntentId: "pi_setup_1",
        setupFeePaidAt: calls.updates[0]?.update?.setupFeePaidAt,
        stripeDefaultPaymentMethodId: "pm_1",
        paymentMethodUpdatedAt: "2027-01-15T08:00:00.000Z",
      },
    },
  ]);
  assert.equal(calls.customerUpdates.length, 1);
  assert.equal(calls.customerUpdates[0].paymentMethodId, "pm_1");
  assert.match(calls.updates[0].update.setupFeePaidAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls.processed.length, 1);
});

test("paid setup-fee Checkout without a customer still marks setup paid", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("checkout.session.completed", {
      id: "cs_setup_fee_customerless",
      mode: "payment",
      payment_intent: "pi_setup_customerless",
      payment_status: "paid",
      metadata: { account_id: "acct_1", charge_type: "setup_fee" },
    }),
    subscriptionAccountId: null,
    customerAccountId: null,
    paymentSnapshot: {
      id: "pi_setup_customerless",
      customerId: null,
      paymentMethodId: null,
      status: "succeeded",
      amount: 15000,
      amountReceived: 15000,
      amountRefunded: 0,
      disputed: false,
      disputeStatus: null,
      livemode: false,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.ignored, []);
  assert.deepEqual(calls.updates, [
    {
      accountId: "acct_1",
      update: {
        setupFeeStatus: "paid",
        setupFeeCheckoutSessionId: "cs_setup_fee_customerless",
        setupFeePaymentIntentId: "pi_setup_customerless",
        setupFeePaidAt: calls.updates[0]?.update?.setupFeePaidAt,
        stripeDefaultPaymentMethodId: null,
        paymentMethodUpdatedAt: "2027-01-15T08:00:00.000Z",
      },
    },
  ]);
  assert.equal(calls.processed.length, 1);
});

test("setup-fee Checkout cannot invent payment from the wrong amount or currency", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("checkout.session.completed", {
      id: "cs_wrong_terms",
      mode: "payment",
      customer: "cus_1",
      payment_intent: "pi_wrong_terms",
      payment_status: "paid",
      metadata: { account_id: "acct_1", charge_type: "setup_fee" },
    }),
    subscriptionAccountId: null,
    paymentSnapshot: {
      id: "pi_wrong_terms",
      customerId: "cus_1",
      paymentMethodId: "pm_1",
      status: "succeeded",
      currency: "cad",
      amount: 15000,
      amountReceived: 15000,
      amountRefunded: 0,
      disputed: false,
      disputeStatus: null,
      livemode: false,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.updates, []);
  assert.equal(calls.ignored[0].reason, "setup_fee_terms_mismatch");
});

test("pilot payment-method Checkout synchronizes the succeeded SetupIntent", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("checkout.session.completed", {
      id: "cs_card_1",
      mode: "setup",
      customer: "cus_1",
      setup_intent: "seti_1",
      metadata: {
        account_id: "acct_1",
        charge_type: "billing_payment_method",
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.retrievedSetupIntents, ["seti_1"]);
  assert.equal(calls.customerUpdates[0].paymentMethodId, "pm_1");
  assert.deepEqual(calls.updates.at(-1), {
    accountId: "acct_1",
    update: {
      stripeCustomerId: "cus_1",
      billingSetupCheckoutSessionId: "cs_card_1",
      stripeSetupIntentId: "seti_1",
      stripeSetupIntentStatus: "succeeded",
      stripeDefaultPaymentMethodId: "pm_1",
      paymentMethodUpdatedAt: "2027-01-15T08:00:00.000Z",
    },
  });
});

test("SetupIntent webhook replay safely synchronizes the Stripe default card", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("setup_intent.succeeded", {
      id: "seti_1",
      customer: "cus_1",
      payment_method: "pm_1",
      status: "succeeded",
      metadata: { account_id: "acct_1" },
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.retrievedSetupIntents, ["seti_1"]);
  assert.equal(calls.customerUpdates.length, 1);
  assert.equal(calls.updates.at(-1).update.stripeDefaultPaymentMethodId, "pm_1");
  assert.equal(calls.processed.length, 1);
});

test("customer.updated keeps Stripe authoritative for the default payment method", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("customer.updated", {
      id: "cus_1",
      invoice_settings: { default_payment_method: "pm_new" },
    }),
    customerSnapshot: {
      id: "cus_1",
      defaultPaymentMethodId: "pm_new",
      livemode: false,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.retrievedCustomers, ["cus_1"]);
  assert.equal(calls.updates.at(-1).update.stripeDefaultPaymentMethodId, "pm_new");
});

test("restart Checkout associates only a verified account-scoped subscription", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("checkout.session.completed", {
      id: "cs_restart",
      mode: "subscription",
      customer: "cus_1",
      subscription: "sub_1",
      metadata: { account_id: "acct_1" },
    }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.retrievedSubscriptions, ["sub_1"]);
  assert.deepEqual(calls.updates, [{
    accountId: "acct_1",
    update: {
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripePriceId: "price_123",
    },
  }]);
});

test("restart Checkout rejects mismatched subscription metadata", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("checkout.session.completed", {
      id: "cs_restart_mismatch",
      mode: "subscription",
      customer: "cus_1",
      subscription: "sub_1",
      metadata: { account_id: "acct_1" },
    }),
    subscriptionSnapshot: subscription({ metadataAccountId: "acct_other" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.updates, []);
  assert.equal(calls.ignored[0].reason, "subscription_identity_mismatch");
});

test("full setup-fee refund is reflected from Stripe", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("charge.refunded", {
      id: "ch_1",
      customer: "cus_1",
      payment_intent: "pi_setup_1",
      amount: 15000,
      amount_refunded: 15000,
    }),
    paymentIntentAccountId: "acct_1",
    customerAccountId: null,
    paymentSnapshot: {
      id: "pi_setup_1", customerId: "cus_1", status: "succeeded",
      amount: 15000, amountReceived: 15000, amountRefunded: 15000, disputed: false,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls.updates.at(-1).update.setupFeeStatus, "refunded");
  assert.equal(calls.updates.at(-1).update.setupFeeRefundedCents, 15000);
});

test("refund.created is authoritative for a setup-fee refund", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("refund.created", {
      id: "re_1",
      customer: "cus_1",
      payment_intent: "pi_setup_1",
      amount: 5000,
      status: "succeeded",
    }),
    paymentIntentAccountId: "acct_1",
    customerAccountId: null,
    paymentSnapshot: {
      id: "pi_setup_1", customerId: "cus_1", status: "succeeded",
      amount: 15000, amountReceived: 15000, amountRefunded: 5000, disputed: false,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates.at(-1).update.setupFeeStatus, "partially_refunded");
  assert.equal(calls.updates.at(-1).update.setupFeeRefundedCents, 5000);
});

test("refund.failed preserves the PaymentIntent's actual payment state", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("refund.failed", {
      id: "re_failed",
      customer: "cus_1",
      payment_intent: "pi_setup_1",
      amount: 15000,
      status: "failed",
    }),
    paymentIntentAccountId: "acct_1",
    customerAccountId: null,
    paymentSnapshot: {
      id: "pi_setup_1", customerId: "cus_1", status: "succeeded",
      amount: 15000, amountReceived: 15000, amountRefunded: 0, disputed: false,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates.at(-1).update.setupFeeStatus, "paid");
  assert.equal(calls.updates.at(-1).update.setupFeeRefundedCents, 0);
});

test("setup-fee dispute is visible without pretending it is a refund", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("charge.dispute.created", {
      id: "dp_1", customer: "cus_1", payment_intent: "pi_setup_1", status: "needs_response",
    }),
    customerAccountId: null,
    paymentIntentAccountId: "acct_1",
    paymentSnapshot: {
      id: "pi_setup_1", customerId: "cus_1", status: "succeeded",
      amount: 15000, amountReceived: 15000, amountRefunded: 0, disputed: true,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls.updates.at(-1).update.setupFeeStatus, "disputed");
  assert.equal(calls.updates.at(-1).update.setupFeeDisputeStatus, "needs_response");
});

test("monthly refund does not alter setup-fee state", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("charge.refunded", {
      id: "ch_monthly",
      customer: "cus_1",
      payment_intent: "pi_monthly_1",
      amount: 9900,
      amount_refunded: 9900,
    }),
    subscriptionAccountId: null,
    customerAccountId: "acct_1",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.updates, []);
  assert.deepEqual(calls.retrievedPayments, []);
  assert.equal(calls.ignored[0].reason, "non_setup_fee_payment_intent");
});

test("monthly dispute does not alter setup-fee state", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("charge.dispute.created", {
      id: "dp_monthly",
      customer: "cus_1",
      payment_intent: "pi_monthly_1",
      status: "needs_response",
    }),
    subscriptionAccountId: null,
    customerAccountId: "acct_1",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.updates, []);
  assert.deepEqual(calls.retrievedPayments, []);
  assert.equal(calls.ignored[0].reason, "non_setup_fee_payment_intent");
});

test("two concurrent copies leave only one processor owning the event", async () => {
  const { response, body, calls } = await runWebhook({
    claim: { status: "already_processing", attemptCount: 1 },
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(body.retry, true);
  assert.equal(body.processingStatus, "already_processing");
  assert.deepEqual(calls.updates, []);
});

test("database failure while claiming an event asks Stripe to retry", async () => {
  const { response, body, calls } = await runWebhook({
    claimError: new Error("Supabase unavailable"),
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(body.retry, true);
  assert.deepEqual(calls.updates, []);
  assert.deepEqual(calls.processed, []);
});

test("conflicting Stripe identifiers cannot cross account boundaries", async () => {
  const { response, calls } = await runWebhook({
    subscriptionAccountId: "acct_1",
    customerAccountId: "acct_2",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.updates, []);
  assert.equal(calls.ignored[0].reason, "account_resolution_conflict");
});

test("a subscription using an unconfigured price fails closed", async () => {
  const { response, calls } = await runWebhook({
    subscriptionSnapshot: subscription({ priceId: "price_not_relay" }),
  });

  assert.equal(response.status, 500);
  assert.deepEqual(calls.updates, []);
  assert.match(calls.failed[0].errorCode, /configured \$99 monthly price/);
});

test("retry after database failure can safely process the same event later", async () => {
  const first = await runWebhook({ updateError: new Error("database unavailable") });
  const second = await runWebhook();

  assert.equal(first.response.status, 500);
  assert.equal(first.calls.failed.length, 1);
  assert.match(first.calls.failed[0].errorCode, /database unavailable/);
  assert.equal(second.response.status, 200);
  assert.equal(second.calls.updates.length, 1);
  assert.equal(second.calls.processed.length, 1);
});

test("late subscription.updated after deletion cannot resurrect a canceled subscription", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("customer.subscription.updated", {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      metadata: { account_id: "acct_1" },
    }),
    subscriptionSnapshot: subscription({ status: "canceled" }),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates[0].update.billingStatus, "canceled");
  assert.equal(calls.updates[0].update.stripeSubscriptionStatus, "canceled");
});

test("a delayed event from an old subscription cannot overwrite a restarted subscription", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("customer.subscription.deleted", {
      id: "sub_old",
      customer: "cus_1",
      status: "canceled",
      metadata: { account_id: "acct_1" },
    }),
    subscriptionSnapshot: subscription({ id: "sub_old", status: "canceled" }),
    existingBilling: {
      billingAttentionSince: null,
      cancelAtPeriodEnd: false,
      stripeSubscriptionId: "sub_new",
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.updates, []);
  assert.equal(calls.ignored[0].reason, "superseded_subscription");
});

test("invoice.payment_failed before subscription update surfaces past-due attention", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("invoice.payment_failed", invoiceObject()),
    subscriptionSnapshot: subscription({ status: "active" }),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates[0].update.billingStatus, "past_due");
  assert.equal(typeof calls.updates[0].update.billingAttentionSince, "string");
  assert.equal(calls.ownerEmails.length, 1);
  assert.equal(calls.ownerEmails[0].type, "payment_failed");
  assert.equal(calls.emails.length, 1);
});

test("invoice.payment_action_required notifies the owner to approve payment", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("invoice.payment_action_required", invoiceObject()),
    subscriptionSnapshot: subscription({ status: "active" }),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates[0].update.billingStatus, "past_due");
  assert.equal(calls.ownerEmails[0].type, "payment_failed");
  assert.equal(calls.ownerEmails[0].input.eventType, "invoice.payment_action_required");
});

test("invoice finalization failure surfaces billing attention", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("invoice.finalization_failed", invoiceObject()),
    subscriptionSnapshot: subscription({ status: "active" }),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates[0].update.billingStatus, "past_due");
  assert.equal(calls.ownerEmails[0].input.eventType, "invoice.finalization_failed");
});

test("a delayed payment failure cannot resurrect a canceled subscription", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("invoice.payment_failed", invoiceObject()),
    subscriptionSnapshot: subscription({ status: "canceled" }),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates[0].update.billingStatus, "canceled");
  assert.equal(calls.updates[0].update.stripeSubscriptionStatus, "canceled");
  assert.deepEqual(calls.ownerEmails, []);
});

test("billing_attention_since is preserved across repeated failed-payment events", async () => {
  const previousAttention = "2026-07-01T00:00:00.000Z";
  const { response, calls } = await runWebhook({
    event: stripeEvent("invoice.payment_failed", invoiceObject()),
    subscriptionSnapshot: subscription({ status: "active" }),
    existingBilling: {
      billingAttentionSince: previousAttention,
      cancelAtPeriodEnd: false,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates[0].update.billingAttentionSince, previousAttention);
});

test("invoice.paid after past due restores active state from current subscription", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("invoice.paid", invoiceObject({
      paid: true,
      status: "paid",
      amount_paid: 9900,
      status_transitions: { paid_at: 1_800_000_000 },
    })),
    subscriptionSnapshot: subscription({ status: "active" }),
    existingBilling: {
      billingAttentionSince: "2026-07-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates[0].update.billingStatus, "active");
  assert.equal(calls.updates[0].update.billingAttentionSince, null);
  assert.equal(calls.updates[0].update.firstPaidAt, "2027-01-15T08:00:00.000Z");
  assert.equal(calls.updates[0].update.guaranteeEndsAt, "2027-02-14T08:00:00.000Z");
  assert.equal(calls.ownerEmails.length, 1);
  assert.equal(calls.ownerEmails[0].type, "billing_recovered");
});

test("zero-dollar invoice.paid does not establish first paid or guarantee dates", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("invoice.paid", invoiceObject({
      paid: true,
      status: "paid",
      amount_paid: 0,
      status_transitions: { paid_at: 1_800_000_000 },
    })),
    subscriptionSnapshot: subscription({ status: "trialing" }),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates[0].update.firstPaidAt, undefined);
  assert.equal(calls.updates[0].update.guaranteeEndsAt, undefined);
});

test("subscription scheduled to cancel notifies the owner without canceling service early", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("customer.subscription.updated", {
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      metadata: { account_id: "acct_1" },
    }),
    subscriptionSnapshot: subscription({
      status: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: "2026-08-01T00:00:00.000Z",
    }),
    existingBilling: {
      billingAttentionSince: null,
      cancelAtPeriodEnd: false,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates[0].update.billingStatus, "active");
  assert.equal(calls.updates[0].update.cancelAtPeriodEnd, true);
  assert.equal(calls.ownerEmails.length, 1);
  assert.equal(calls.ownerEmails[0].type, "subscription_scheduled_to_end");
});

test("Stripe trial-ending event notifies the owner without changing the trial locally", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("customer.subscription.trial_will_end", {
      id: "sub_1",
      customer: "cus_1",
      status: "trialing",
      metadata: { account_id: "acct_1" },
    }),
    subscriptionSnapshot: subscription({
      status: "trialing",
      trialStartsAt: "2026-07-23T00:00:00.000Z",
      trialEndsAt: "2026-08-06T00:00:00.000Z",
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates[0].update.billingStatus, "trialing");
  assert.equal(calls.ownerEmails[0].type, "trial_ending");
  assert.equal(calls.ownerEmails[0].input.trialEndsAt, "2026-08-06T00:00:00.000Z");
});

test("unknown Stripe customer is recorded as ignored", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("invoice.payment_failed", invoiceObject({ customer: "cus_unknown" })),
    subscriptionAccountId: null,
    customerAccountId: null,
    metadataAccountExists: false,
  });

  assert.equal(response.status, 200);
  assert.equal(calls.ignored[0].reason, "account_unresolved");
  assert.deepEqual(calls.updates, []);
});

test("missing account metadata on initial checkout association is ignored", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("checkout.session.completed", {
      id: "cs_1",
      customer: "cus_new",
      subscription: "sub_new",
      metadata: {},
    }),
    subscriptionAccountId: null,
    customerAccountId: null,
    metadataAccountExists: false,
  });

  assert.equal(response.status, 200);
  assert.equal(calls.ignored[0].reason, "account_unresolved");
  assert.deepEqual(calls.updates, []);
});

test("test-mode versus live-mode mismatch is recorded and ignored", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("invoice.paid", invoiceObject({ paid: true, status: "paid" }), { livemode: false }),
    stripeSecretKey: "sk_live_example",
  });

  assert.equal(response.status, 200);
  assert.equal(calls.ignored[0].reason, "livemode_mismatch");
  assert.deepEqual(calls.updates, []);
});

test("database failure after event claim marks the event failed", async () => {
  const { response, calls } = await runWebhook({ updateError: new Error("write timeout") });

  assert.equal(response.status, 500);
  assert.equal(calls.failed.length, 1);
  assert.match(calls.failed[0].errorCode, /write timeout/);
});

test("email failure after billing state succeeds does not fail the event", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("invoice.payment_failed", invoiceObject()),
    emailError: new Error("resend down"),
    ownerEmailError: new Error("owner email down"),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.processed.length, 1);
  assert.equal(calls.failed.length, 0);
});

test("account lookup failure for billing emails does not fail the Stripe event", async () => {
  const { response, calls } = await runWebhook({
    event: stripeEvent("invoice.payment_failed", invoiceObject()),
    accountConfigError: new Error("account config unavailable"),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.processed.length, 1);
  assert.deepEqual(calls.ownerEmails, []);
  assert.equal(calls.emails.length, 1);
});
