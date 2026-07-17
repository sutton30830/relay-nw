import assert from "node:assert/strict";
import test from "node:test";
import {
  redactStripeSecret,
  requiredStripeWebhookEvents,
  verifyBillingConfig,
} from "../scripts/verify-billing.mjs";

const baseEnv = {
  STRIPE_SECRET_KEY: "sk_test_1234567890abcdef",
  STRIPE_WEBHOOK_SECRET: "whsec_1234567890abcdef",
  STRIPE_PRICE_ID: "price_relay_99",
  APP_BASE_URL: "http://localhost:3000",
};

function stripeResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchMock(overrides = {}) {
  const calls = [];
  const responses = {
    "/v1/prices/price_relay_99": {
      id: "price_relay_99",
      active: true,
      type: "recurring",
      currency: "usd",
      unit_amount: 9900,
      livemode: false,
      recurring: {
        interval: "month",
        interval_count: 1,
      },
    },
    "/v1/billing_portal/configurations?active=true&limit=10": {
      data: [{ id: "bpc_123", active: true }],
    },
    "/v1/webhook_endpoints?limit=100": {
      data: [
        {
          id: "we_123",
          status: "enabled",
          url: "http://localhost:3000/api/stripe/webhook",
          enabled_events: requiredStripeWebhookEvents,
        },
      ],
    },
    ...overrides,
  };

  const fetchImpl = async (url) => {
    calls.push(url);
    const path = new URL(url).pathname + new URL(url).search;
    const response = responses[path];

    if (!response) {
      return stripeResponse({ error: { message: `Unexpected ${path}` } }, 404);
    }

    if (response instanceof Response) {
      return response;
    }

    return stripeResponse(response);
  };

  fetchImpl.calls = calls;
  return fetchImpl;
}

function labels(result) {
  return result.checks.map((check) => check.label);
}

test("billing verifier fails closed when required environment is missing", async () => {
  const fetchImpl = fetchMock();
  const result = await verifyBillingConfig({ env: {}, fetchImpl });

  assert.equal(result.ok, false);
  assert.deepEqual(fetchImpl.calls, []);
  assert.match(result.checks[0].detail, /STRIPE_SECRET_KEY/);
  assert.match(result.checks[0].detail, /APP_BASE_URL/);
});

test("billing verifier passes for the expected Stripe price, portal, and webhook config", async () => {
  const result = await verifyBillingConfig({ env: baseEnv, fetchImpl: fetchMock() });

  assert.equal(result.ok, true);
  assert.deepEqual(labels(result), [
    "Stripe secret key",
    "App base URL",
    "Stripe price active",
    "Stripe price interval",
    "Stripe price amount",
    "Stripe price mode",
    "Customer Portal configuration",
    "Stripe webhook endpoint",
    "Stripe webhook events",
  ]);
});

test("billing verifier blocks the wrong owner-facing price", async () => {
  const fetchImpl = fetchMock({
    "/v1/prices/price_relay_99": {
      id: "price_relay_99",
      active: true,
      type: "recurring",
      currency: "usd",
      unit_amount: 3000,
      livemode: false,
      recurring: { interval: "month", interval_count: 1 },
    },
  });
  const result = await verifyBillingConfig({ env: baseEnv, fetchImpl });

  assert.equal(result.ok, false);
  assert.match(result.checks.find((check) => check.label === "Stripe price amount")?.detail ?? "", /Expected usd 9900/);
});

test("billing verifier blocks when Customer Portal has no active configuration", async () => {
  const fetchImpl = fetchMock({
    "/v1/billing_portal/configurations?active=true&limit=10": {
      data: [],
    },
  });
  const result = await verifyBillingConfig({ env: baseEnv, fetchImpl });

  assert.equal(result.ok, false);
  assert.match(result.checks.find((check) => check.label === "Customer Portal configuration")?.detail ?? "", /No active/);
});

test("billing verifier blocks when the production webhook is missing required events", async () => {
  const fetchImpl = fetchMock({
    "/v1/webhook_endpoints?limit=100": {
      data: [
        {
          id: "we_123",
          status: "enabled",
          url: "http://localhost:3000/api/stripe/webhook",
          enabled_events: ["checkout.session.completed"],
        },
      ],
    },
  });
  const result = await verifyBillingConfig({ env: baseEnv, fetchImpl });

  assert.equal(result.ok, false);
  assert.match(result.checks.find((check) => check.label === "Stripe webhook events")?.detail ?? "", /invoice\.paid/);
});

test("billing verifier blocks live Stripe keys pointed at localhost", async () => {
  const fetchImpl = fetchMock({
    "/v1/prices/price_relay_99": {
      id: "price_relay_99",
      active: true,
      type: "recurring",
      currency: "usd",
      unit_amount: 9900,
      livemode: true,
      recurring: { interval: "month", interval_count: 1 },
    },
  });
  const result = await verifyBillingConfig({
    env: {
      ...baseEnv,
      STRIPE_SECRET_KEY: "sk_live_1234567890abcdef",
    },
    fetchImpl,
  });

  assert.equal(result.ok, false);
  assert.match(result.checks.find((check) => check.label === "Production app URL")?.detail ?? "", /localhost/);
});

test("billing verifier redacts Stripe secrets in output helpers", () => {
  assert.equal(redactStripeSecret("sk_test_1234567890abcdef"), "sk_test_…cdef");
  assert.equal(redactStripeSecret("short"), "••••");
});
