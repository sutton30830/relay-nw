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
    trialEndsAt: null,
    currentPeriodEnd: "2026-08-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
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
  subscriptionSnapshot = subscription(),
  subscriptionError = null,
  subscriptionAccountId = "acct_1",
  customerAccountId = "acct_1",
  metadataAccountExists = true,
  updateError = null,
  emailError = null,
  ownerEmailError = null,
  accountConfigError = null,
  existingBilling = {
    billingAttentionSince: null,
    cancelAtPeriodEnd: false,
  },
  stripeSecretKey = "sk_test_example",
} = {}) {
  const calls = {
    claims: [],
    resolvedSubscriptions: [],
    resolvedCustomers: [],
    accountExists: [],
    retrievedSubscriptions: [],
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
    },
    "@/lib/stripe-billing": {
      ...realStripeBilling,
      assertStripeWebhookConfigured: () => {},
      verifyStripeWebhookSignature: () => true,
      retrieveStripeSubscription: async (stripeSubscriptionId) => {
        calls.retrievedSubscriptions.push(stripeSubscriptionId);
        if (subscriptionError) throw subscriptionError;
        return subscriptionSnapshot;
      },
    },
    "@/lib/supabase": {
      claimStripeEvent: async (input) => {
        calls.claims.push(input);
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

test("two concurrent copies leave only one processor owning the event", async () => {
  const { response, body, calls } = await runWebhook({
    claim: { status: "already_processing", attemptCount: 1 },
  });

  assert.equal(response.status, 200);
  assert.equal(body.processingStatus, "already_processing");
  assert.deepEqual(calls.updates, []);
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
    event: stripeEvent("invoice.paid", invoiceObject({ paid: true, status: "paid" })),
    subscriptionSnapshot: subscription({ status: "active" }),
    existingBilling: {
      billingAttentionSince: "2026-07-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(calls.updates[0].update.billingStatus, "active");
  assert.equal(calls.updates[0].update.billingAttentionSince, null);
  assert.equal(calls.ownerEmails.length, 1);
  assert.equal(calls.ownerEmails[0].type, "billing_recovered");
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
