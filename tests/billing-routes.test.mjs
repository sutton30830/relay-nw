import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Phase 1 route coverage. Initial trial creation is server-managed after full
// text-back activation; subscription Checkout is only a restart path.

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

const customerExperienceContract = await loadTsModule("lib/customer-experience-contract.ts", {});
const billing = await loadTsModule("lib/billing.ts", {
  "@/lib/customer-experience-contract": customerExperienceContract,
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
    ...billing.defaultBillingRecord(),
    ...overrides,
  };
}

async function runCheckout({
  authSession = session(),
  accountBilling = billingRecord(),
  technicalStatus = "live",
  a2pStatus = "approved",
} = {}) {
  const calls = {
    billingLookups: [],
    checkoutInputs: [],
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
    "@/lib/customer-experience-contract": customerExperienceContract,
    "@/lib/stripe-billing": {
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
      getAccountTechnicalSetupStatus: async () => technicalStatus,
      getA2pRegistrationStatus: async () => a2pStatus,
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

async function runPaymentMethod({
  authSession = session(),
  accountBilling = billingRecord({
    commercialOffer: "founding_pilot",
    billingPolicy: "setup_fee_waived",
    setupFeeStatus: "waived",
  }),
  existingCheckout = null,
} = {}) {
  const calls = {
    billingLookups: [],
    checkoutInputs: [],
    checkoutLookups: [],
    billingUpdates: [],
    redirects: [],
  };

  const { POST } = await loadTsModule("app/api/billing/payment-method/route.ts", {
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
    "@/lib/customer-experience-contract": customerExperienceContract,
    "@/lib/stripe-billing": {
      createStripePaymentMethodCheckoutSession: async (input) => {
        calls.checkoutInputs.push(input);
        return { id: "cs_card_123", url: "https://checkout.stripe.test/card" };
      },
      retrieveStripeCheckoutSession: async (sessionId) => {
        calls.checkoutLookups.push(sessionId);
        if (existingCheckout instanceof Error) throw existingCheckout;
        return existingCheckout;
      },
    },
    "@/lib/supabase": {
      getAccountBillingRecord: async (accountId) => {
        calls.billingLookups.push(accountId);
        return accountBilling;
      },
      updateAccountBillingRecord: async (accountId, update) => {
        calls.billingUpdates.push({ accountId, update });
      },
    },
  });

  try {
    await POST();
  } catch (error) {
    if (!String(error?.message ?? "").startsWith("REDIRECT:")) throw error;
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
  form = { account_slug: "demo", action: "comp", reason: "Approved pilot exception" },
} = {}) {
  const calls = {
    lookups: [],
    policies: [],
    commercialOffers: [],
    platformAudits: [],
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
      requirePlatformOperatorWrite: async () => authSession,
    },
    "@/lib/billing": billing,
    "@/lib/supabase": {
      getOpsBillingAccountBySlug: async (slug) => {
        calls.lookups.push(slug);
        return accountBilling;
      },
      setAccountBillingPolicy: async (input) => {
        calls.policies.push(input);
      },
      setAccountCommercialOffer: async (input) => {
        calls.commercialOffers.push(input);
      },
      recordPlatformAuditEvent: async (input) => {
        calls.platformAudits.push(input);
      },
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

test("initial subscription Checkout is unavailable because activation creates the Stripe trial", async () => {
  const calls = await runCheckout();

  assert.deepEqual(calls.checkoutInputs, []);
  assert.deepEqual(calls.redirects, ["/settings?billing=initial_trial_managed_automatically#billing"]);
});

test("viewer and admin cannot initiate billing", async () => {
  for (const role of ["viewer", "admin"]) {
    const calls = await runCheckout({ authSession: session({ role }) });

    assert.deepEqual(calls.checkoutInputs, []);
    assert.deepEqual(calls.redirects, ["/settings?billing=forbidden#billing"]);
  }
});

test("selected account determines the Stripe customer used for restart Checkout", async () => {
  const calls = await runCheckout({
    authSession: session({
      accountId: "acct-b",
      account: { ...session().account, accountSlug: "tenant-b", smsEnabled: true },
    }),
    accountBilling: billingRecord({
      billingStatus: "canceled",
      stripeSubscriptionStatus: "canceled",
      stripeCustomerId: "cus_tenant_b",
      activatedAt: "2026-07-23T00:00:00.000Z",
    }),
  });

  assert.deepEqual(calls.billingLookups, ["acct-b"]);
  assert.equal(calls.checkoutInputs.length, 1);
  assert.equal(calls.checkoutInputs[0].accountId, "acct-b");
  assert.equal(calls.checkoutInputs[0].stripeCustomerId, "cus_tenant_b");
});

test("calls working alone cannot restart a canceled subscription", async () => {
  const calls = await runCheckout({
    authSession: session({
      account: { ...session().account, smsEnabled: false },
    }),
    accountBilling: billingRecord({
      billingStatus: "canceled",
      stripeSubscriptionStatus: "canceled",
      stripeCustomerId: "cus_1",
      activatedAt: "2026-07-23T00:00:00.000Z",
    }),
    technicalStatus: "live",
    a2pStatus: "in_progress",
  });

  assert.deepEqual(calls.checkoutInputs, []);
  assert.deepEqual(calls.redirects, [
    "/settings?billing=setup_incomplete#billing",
  ]);
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
    authSession: session({
      account: { ...session().account, smsEnabled: true },
    }),
    accountBilling: billingRecord({
      billingStatus: "canceled",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_canceled",
      stripeSubscriptionStatus: "canceled",
      activatedAt: "2026-07-23T00:00:00.000Z",
    }),
  });

  assert.equal(calls.checkoutInputs.length, 1);
  assert.equal(calls.checkoutInputs[0].stripeCustomerId, "cus_1");
  assert.equal(calls.redirects.at(-1), "https://checkout.stripe.test/session");
});

test("double Checkout submission uses the same deterministic Stripe idempotency key", async () => {
  const canceled = billingRecord({
    billingStatus: "canceled",
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_old",
    stripeSubscriptionStatus: "canceled",
    activatedAt: "2026-07-23T00:00:00.000Z",
  });
  const readySession = session({
    account: { ...session().account, smsEnabled: true },
  });
  const first = await runCheckout({
    authSession: readySession,
    accountBilling: canceled,
  });
  const second = await runCheckout({
    authSession: readySession,
    accountBilling: canceled,
  });

  assert.equal(first.checkoutInputs.length, 1);
  assert.equal(second.checkoutInputs.length, 1);
  assert.equal(first.checkoutInputs[0].idempotencyKey, second.checkoutInputs[0].idempotencyKey);
});

test("a standard account must pay setup before collecting the reusable card", async () => {
  const calls = await runPaymentMethod({
    accountBilling: billingRecord({
      commercialOffer: "standard",
      billingPolicy: "standard",
      setupFeeStatus: "due",
    }),
  });

  assert.deepEqual(calls.checkoutInputs, []);
  assert.deepEqual(calls.redirects, ["/settings?billing=setup_fee_required#billing"]);
});

test("founding pilot securely collects a card with the 30-day terms", async () => {
  const calls = await runPaymentMethod({
    authSession: session({ accountId: "pilot-1", account: { ...session().account, accountSlug: "founding-pilot" } }),
  });

  assert.deepEqual(calls.billingLookups, ["pilot-1"]);
  assert.equal(calls.checkoutInputs.length, 1);
  assert.equal(calls.checkoutInputs[0].accountId, "pilot-1");
  assert.equal(calls.checkoutInputs[0].trialDays, 30);
  assert.deepEqual(calls.billingUpdates, [{
    accountId: "pilot-1",
    update: { billingSetupCheckoutSessionId: "cs_card_123" },
  }]);
  assert.equal(calls.redirects.at(-1), "https://checkout.stripe.test/card");
});

test("an open payment-method Checkout is reused without creating a duplicate", async () => {
  const calls = await runPaymentMethod({
    accountBilling: billingRecord({
      commercialOffer: "founding_pilot",
      billingPolicy: "setup_fee_waived",
      setupFeeStatus: "waived",
      billingSetupCheckoutSessionId: "cs_open",
    }),
    existingCheckout: {
      id: "cs_open",
      status: "open",
      url: "https://checkout.stripe.test/existing-card",
      paymentStatus: "no_payment_required",
    },
  });

  assert.deepEqual(calls.checkoutLookups, ["cs_open"]);
  assert.deepEqual(calls.checkoutInputs, []);
  assert.deepEqual(calls.billingUpdates, []);
  assert.equal(calls.redirects.at(-1), "https://checkout.stripe.test/existing-card");
});

test("operator can manually comp an account without a live Stripe subscription", async () => {
  const calls = await runOpsBillingOverride();

  assert.deepEqual(calls.lookups, ["demo"]);
  assert.deepEqual(calls.policies, [
    {
      accountId: "acct-1",
      policy: "comped",
      reason: "Approved pilot exception",
      actorUserId: "user-1",
      actorEmail: "ops@example.com",
    },
  ]);
  assert.equal(calls.platformAudits[0].action, "billing.operator.comp");
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
    form: { account_slug: "demo", action: "waive_setup_fee", reason: "Pilot customer" },
  });

  assert.deepEqual(calls.policies, []);
  assert.equal(calls.commercialOffers[0].offer, "founding_pilot");
  assert.equal(calls.commercialOffers[0].reason, "Pilot customer");
  assert.equal(calls.platformAudits[0].action, "billing.operator.waive_setup_fee");
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
    form: { account_slug: "demo", action: "require_setup_fee", reason: "Correcting pilot terms" },
  });

  assert.deepEqual(calls.policies, []);
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?billing_action=setup_fee_already_paid");
});

test("operator cannot grant an app-managed trial", async () => {
  const calls = await runOpsBillingOverride({
    form: { account_slug: "demo", action: "grant_trial", reason: "No longer supported" },
  });

  assert.deepEqual(calls.policies, []);
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?billing_action=invalid_action");
});

test("operator requires a meaningful exception reason", async () => {
  const calls = await runOpsBillingOverride({
    form: { account_slug: "demo", action: "uncomp", reason: "no" },
  });

  assert.deepEqual(calls.policies, []);
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?billing_action=reason_required");
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

  assert.deepEqual(calls.policies, []);
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?billing_action=override_blocked");
});
