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

const billing = await loadTsModule("lib/billing.ts", {
  "@/lib/readiness": {},
  "@/lib/customer-experience-contract": {
    canStartMonthlyBilling: (status) => status === "live",
  },
});

function session(overrides = {}) {
  return {
    accountId: "acct-1",
    email: "owner@example.com",
    role: "owner",
    account: {
      accountSlug: "demo",
      businessName: "Demo Plumbing",
      ownerEmail: "owner@example.com",
      ownerPhoneNumber: "+12065550123",
      twilioPhoneNumber: "+15551234567",
      callMode: "forwarding",
      smsEnabled: false,
    },
    ...overrides,
  };
}

function billingRecord(overrides = {}) {
  return {
    billingStatus: "not_started",
    onboardingStatus: "requirements_needed",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripePriceId: null,
    stripeSubscriptionStatus: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    requirementsDueAt: null,
    activatedAt: null,
    firstPaidAt: null,
    guaranteeEndsAt: null,
    billingAttentionSince: null,
    billingUpdatedAt: null,
    onboardingStatusUpdatedAt: null,
    ...overrides,
  };
}

async function runCheckout({
  authSession = session(),
  accountBilling = billingRecord(),
  callCaptureReady = true,
  smsRegistrationReady = true,
} = {}) {
  const calls = {
    billingLookups: [],
    checkoutInputs: [],
    trialInputs: [],
    redirects: [],
  };

  const { POST } = await loadTsModule("app/api/billing/checkout/route.ts", {
    "next/navigation": {
      redirect: (url) => {
        calls.redirects.push(url);
        throw Object.assign(new Error(`REDIRECT:${url}`), { url });
      },
    },
    "@/lib/auth": {
      requireAccountUser: async () => authSession,
    },
    "@/lib/billing": billing,
    "@/lib/readiness": {
      computeSetupReadiness: () => ({ callCaptureReady, smsRegistrationReady }),
    },
    "@/lib/stripe-billing": {
      checkoutTrialPeriodDays: (input) => {
        calls.trialInputs.push(input);
        return input.billingStatus === "trialing" ? 12 : 30;
      },
      createStripeCheckoutSession: async (input) => {
        calls.checkoutInputs.push(input);
        return { id: "cs_test_123", url: "https://checkout.stripe.test/session" };
      },
    },
    "@/lib/supabase": {
      getAccountBillingRecord: async (accountId) => {
        calls.billingLookups.push(accountId);
        return accountBilling;
      },
      getAccountTechnicalSetupStatus: async () => callCaptureReady ? "live" : "waiting_for_forwarding",
    },
  });

  try {
    await POST();
  } catch (error) {
    if (!String(error?.message ?? "").startsWith("REDIRECT:")) {
      throw error;
    }
  }

  return calls;
}

async function runPortal({
  authSession = session(),
  accountBilling = billingRecord({ billingStatus: "past_due", stripeCustomerId: "cus_1" }),
  requestBody = null,
} = {}) {
  const calls = {
    billingLookups: [],
    portalInputs: [],
    redirects: [],
  };

  const { POST } = await loadTsModule("app/api/billing/portal/route.ts", {
    "next/navigation": {
      redirect: (url) => {
        calls.redirects.push(url);
        throw Object.assign(new Error(`REDIRECT:${url}`), { url });
      },
    },
    "@/lib/auth": {
      requireAccountUser: async () => authSession,
    },
    "@/lib/env": {
      env: { appBaseUrl: "https://www.relay-nw.com" },
    },
    "@/lib/stripe-billing": {
      createStripePortalSession: async (input) => {
        calls.portalInputs.push(input);
        return { id: "bps_123", url: "https://billing.stripe.test/session" };
      },
    },
    "@/lib/supabase": {
      getAccountBillingRecord: async (accountId) => {
        calls.billingLookups.push(accountId);
        return accountBilling;
      },
    },
  });

  try {
    await POST(new Request("http://localhost:3000/api/billing/portal", {
      method: "POST",
      body: requestBody,
    }));
  } catch (error) {
    if (!String(error?.message ?? "").startsWith("REDIRECT:")) {
      throw error;
    }
  }

  return calls;
}

async function runOpsBillingOverride({
  authSession = { userId: "user-1", email: "ops@example.com" },
  accountBilling = billingRecord({ accountId: "acct-1", accountSlug: "demo", businessName: "Demo Plumbing" }),
  form = { account_slug: "demo", action: "comp" },
} = {}) {
  const calls = {
    lookups: [],
    updates: [],
    audits: [],
    redirects: [],
  };

  const { POST } = await loadTsModule("app/api/ops/billing/route.ts", {
    "next/navigation": {
      redirect: (url) => {
        calls.redirects.push(url);
        throw Object.assign(new Error(`REDIRECT:${url}`), { url });
      },
    },
    "@/lib/auth": {
      requirePlatformOperator: async () => authSession,
    },
    "@/lib/billing": billing,
    "@/lib/supabase": {
      getOpsBillingAccountBySlug: async (slug) => {
        calls.lookups.push(slug);
        return accountBilling;
      },
      updateAccountBillingRecord: async (accountId, update) => {
        calls.updates.push({ accountId, update });
      },
      recordAccountAuditEvents: async (input) => {
        calls.audits.push(input);
      },
      recordPlatformAuditEvent: async () => {},
    },
  });

  const body = new FormData();
  for (const [key, value] of Object.entries(form)) {
    body.set(key, value);
  }

  try {
    await POST(new Request("http://localhost:3000/api/ops/billing", {
      method: "POST",
      body,
    }));
  } catch (error) {
    if (!String(error?.message ?? "").startsWith("REDIRECT:")) {
      throw error;
    }
  }

  return calls;
}

test("direct Checkout before activation readiness fails", async () => {
  const calls = await runCheckout({ callCaptureReady: false, smsRegistrationReady: true });

  assert.deepEqual(calls.checkoutInputs, []);
  assert.deepEqual(calls.redirects, ["/settings?billing=setup_incomplete#billing"]);
});

test("viewer and admin cannot initiate billing", async () => {
  for (const role of ["viewer", "admin"]) {
    const calls = await runCheckout({ authSession: session({ role }) });

    assert.deepEqual(calls.checkoutInputs, []);
    assert.deepEqual(calls.redirects, ["/settings?billing=forbidden#billing"]);
  }
});

test("selected account determines the Stripe customer used for Checkout", async () => {
  const calls = await runCheckout({
    authSession: session({ accountId: "acct-b", account: { ...session().account, accountSlug: "tenant-b" } }),
    accountBilling: billingRecord({ stripeCustomerId: "cus_tenant_b" }),
  });

  assert.deepEqual(calls.billingLookups, ["acct-b"]);
  assert.equal(calls.checkoutInputs.length, 1);
  assert.equal(calls.checkoutInputs[0].accountId, "acct-b");
  assert.equal(calls.checkoutInputs[0].stripeCustomerId, "cus_tenant_b");
  assert.equal(calls.checkoutInputs[0].trialPeriodDays, 0);
});

test("active subscription cannot create duplicate Checkout", async () => {
  const calls = await runCheckout({
    accountBilling: billingRecord({
      billingStatus: "active",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeSubscriptionStatus: "active",
    }),
  });

  assert.deepEqual(calls.checkoutInputs, []);
  assert.deepEqual(calls.redirects, ["/settings?billing=already_active#billing"]);
});

test("past-due subscription opens Portal instead of Checkout", async () => {
  const checkoutCalls = await runCheckout({
    accountBilling: billingRecord({
      billingStatus: "past_due",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeSubscriptionStatus: "past_due",
    }),
  });
  const portalCalls = await runPortal({
    accountBilling: billingRecord({
      billingStatus: "past_due",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeSubscriptionStatus: "past_due",
    }),
  });

  assert.deepEqual(checkoutCalls.checkoutInputs, []);
  assert.deepEqual(checkoutCalls.redirects, ["/settings?billing=past_due#billing"]);
  assert.equal(portalCalls.portalInputs.length, 1);
  assert.equal(portalCalls.portalInputs[0].stripeCustomerId, "cus_1");
  assert.equal(portalCalls.redirects.at(-1), "https://billing.stripe.test/session");
});

test("one tenant cannot open another tenant's Portal through request input", async () => {
  const calls = await runPortal({
    authSession: session({ accountId: "acct-a" }),
    accountBilling: billingRecord({ stripeCustomerId: "cus_account_a" }),
    requestBody: new URLSearchParams({ accountId: "acct-b", stripe_customer_id: "cus_account_b" }),
  });

  assert.deepEqual(calls.billingLookups, ["acct-a"]);
  assert.equal(calls.portalInputs[0].stripeCustomerId, "cus_account_a");
});

test("fully canceled subscription can restart through Checkout", async () => {
  const calls = await runCheckout({
    accountBilling: billingRecord({
      billingStatus: "canceled",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_canceled",
      stripeSubscriptionStatus: "canceled",
    }),
  });

  assert.equal(calls.checkoutInputs.length, 1);
  assert.equal(calls.checkoutInputs[0].stripeCustomerId, "cus_1");
  assert.equal(calls.redirects.at(-1), "https://checkout.stripe.test/session");
});

test("double Checkout submission uses the same deterministic Stripe idempotency key", async () => {
  const first = await runCheckout({ accountBilling: billingRecord({ stripeCustomerId: "cus_1" }) });
  const second = await runCheckout({ accountBilling: billingRecord({ stripeCustomerId: "cus_1" }) });

  assert.equal(first.checkoutInputs.length, 1);
  assert.equal(second.checkoutInputs.length, 1);
  assert.equal(first.checkoutInputs[0].idempotencyKey, second.checkoutInputs[0].idempotencyKey);
});

test("Checkout honors the selected account's remaining app-level trial", async () => {
  const calls = await runCheckout({
    accountBilling: billingRecord({
      billingStatus: "trialing",
      trialEndsAt: "2026-08-01T00:00:00.000Z",
    }),
  });

  assert.deepEqual(calls.trialInputs, [
    {
      billingStatus: "trialing",
      trialEndsAt: "2026-08-01T00:00:00.000Z",
    },
  ]);
  assert.equal(calls.checkoutInputs[0].trialPeriodDays, 12);
});

test("activation Checkout is independent from setup-fee collection", async () => {
  const calls = await runCheckout({
    accountBilling: billingRecord({ setupFeeStatus: "due" }),
  });

  assert.equal(calls.checkoutInputs.length, 1);
});

test("standard activation Checkout does not add a Stripe trial", async () => {
  const calls = await runCheckout({
    accountBilling: billingRecord({ setupFeeStatus: "waived" }),
  });

  assert.equal(calls.checkoutInputs[0].trialPeriodDays, 0);
});

test("operator can manually comp an account without a live Stripe subscription", async () => {
  const calls = await runOpsBillingOverride();

  assert.deepEqual(calls.lookups, ["demo"]);
  assert.deepEqual(calls.updates, [
    {
      accountId: "acct-1",
      update: {
        billingPolicy: "comped",
        billingStatus: "comped",
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        billingAttentionSince: null,
      },
    },
  ]);
  assert.equal(calls.audits.length, 1);
  assert.equal(calls.audits[0].accountId, "acct-1");
  assert.equal(calls.audits[0].events[0].action, "billing.operator.comp");
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?billing_action=comp");
});

test("operator can waive a setup fee for a selected pilot account and audit the reason", async () => {
  const calls = await runOpsBillingOverride({
    accountBilling: billingRecord({
      accountId: "acct-1",
      accountSlug: "demo",
      businessName: "Demo Plumbing",
      setupFeeStatus: "due",
    }),
    form: { account_slug: "demo", action: "waive_setup_fee", waiver_reason: "Pilot customer" },
  });

  assert.equal(calls.updates[0].update.setupFeeStatus, "waived");
  assert.equal(calls.updates[0].update.setupFeeWaiverReason, "Pilot customer");
  assert.equal(calls.audits[0].events[0].action, "billing.operator.waive_setup_fee");
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?billing_action=waive_setup_fee");
});

test("operator cannot overwrite a paid setup fee", async () => {
  const calls = await runOpsBillingOverride({
    accountBilling: billingRecord({
      accountId: "acct-1",
      accountSlug: "demo",
      businessName: "Demo Plumbing",
      setupFeeStatus: "paid",
    }),
    form: { account_slug: "demo", action: "require_setup_fee" },
  });

  assert.deepEqual(calls.updates, []);
  assert.deepEqual(calls.audits, []);
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?billing_action=setup_fee_already_paid");
});

test("operator can grant a bounded manual trial", async () => {
  const calls = await runOpsBillingOverride({
    form: { account_slug: "demo", action: "grant_trial", trial_days: "120" },
  });

  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0].update.billingStatus, "trialing");
  assert.match(calls.updates[0].update.trialEndsAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls.updates[0].update.cancelAtPeriodEnd, false);
  assert.equal(calls.audits[0].events[0].summary, "Granted 90-day trial");
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?billing_action=grant_trial");
});

test("operator can end a manual trial without mutating durable lifecycle dates", async () => {
  const calls = await runOpsBillingOverride({
    accountBilling: billingRecord({
      accountId: "acct-1",
      accountSlug: "demo",
      businessName: "Demo Plumbing",
      billingStatus: "trialing",
      trialEndsAt: "2026-08-01T00:00:00.000Z",
      activatedAt: "2026-07-01T00:00:00.000Z",
      firstPaidAt: "2026-07-02T00:00:00.000Z",
      guaranteeEndsAt: "2026-08-01T00:00:00.000Z",
    }),
    form: { account_slug: "demo", action: "end_trial_now" },
  });

  assert.deepEqual(calls.updates, [
    {
      accountId: "acct-1",
      update: {
        billingStatus: "not_started",
        trialEndsAt: null,
        cancelAtPeriodEnd: false,
        billingAttentionSince: null,
      },
    },
  ]);
  assert.equal(calls.audits[0].events[0].action, "billing.operator.end_trial_now");
});

test("operator billing override refuses active Stripe subscriptions", async () => {
  const calls = await runOpsBillingOverride({
    accountBilling: billingRecord({
      accountId: "acct-1",
      accountSlug: "demo",
      businessName: "Demo Plumbing",
      billingStatus: "active",
      stripeSubscriptionId: "sub_live",
      stripeSubscriptionStatus: "active",
    }),
  });

  assert.deepEqual(calls.updates, []);
  assert.deepEqual(calls.audits, []);
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?billing_action=override_blocked");
});
