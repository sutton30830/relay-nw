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
      getA2pRegistrationStatus: async () => "approved",
      getAccountRecoveryStats: async () => ({ missedCalls: 1 }),
      getForwardingHealthSummary: async () => ({ displayStatus: "passed", lastPassedAt: "2026-07-01T00:00:00.000Z" }),
      getLastRecoveredCallAt: async () => "2026-07-01T00:00:00.000Z",
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
