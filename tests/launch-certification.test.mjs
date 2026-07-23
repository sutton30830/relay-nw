import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeLaunchCertification, parseLaunchArgs } from "../scripts/verify-launch.mjs";

function readyFacts(overrides = {}) {
  return {
    account: {
      id: "acct_1",
      slug: "demo",
      name: "Demo Plumbing",
      status: "active",
      billing_status: "active",
      onboarding_status: "activated",
      stripe_customer_id: "cus_123",
      stripe_subscription_id: "sub_123",
      stripe_price_id: "price_123",
      stripe_subscription_status: "active",
      setup_fee_status: "paid",
      ...overrides.account,
    },
    settings: {
      business_name: "Demo Plumbing",
      owner_email: "owner@example.com",
      owner_phone_number: "+12065550123",
      call_mode: "forwarding",
      sms_enabled: true,
      a2p_registration_status: "approved",
      ...overrides.settings,
    },
    primaryNumber: {
      phone_number: "+14253689655",
      is_primary: true,
      twilio_sid: "PN123",
      ...overrides.primaryNumber,
    },
    adminUsers: [
      { role: "owner", email: "owner@example.com", user_id: "user_123" },
      ...(overrides.adminUsers ?? []),
    ],
    latestLead: Object.hasOwn(overrides, "latestLead")
      ? overrides.latestLead
      : { id: "lead_1", created_at: "2026-08-01T00:00:00.000Z" },
    billingConfigResult: overrides.billingConfigResult ?? {
      ok: true,
      checks: [
        { ok: true, level: "pass", label: "Stripe environment", detail: "ok" },
      ],
    },
  };
}

test("launch verifier passes for a ready account", () => {
  const result = analyzeLaunchCertification(readyFacts());
  assert.equal(result.ok, true);
});

test("launch verifier fails for incomplete setup", () => {
  const result = analyzeLaunchCertification(readyFacts({
    latestLead: null,
    account: { onboarding_status: "setting_up", billing_status: "not_started", stripe_subscription_status: null },
  }));

  assert.equal(result.ok, false);
  assert.match(result.checks.find((check) => check.label === "call capture readiness").detail, /not recovered a real missed call/i);
});

test("launch verifier fails for unsafe or missing Stripe config", () => {
  const result = analyzeLaunchCertification(readyFacts({
    billingConfigResult: {
      ok: false,
      checks: [{ ok: false, level: "fail", label: "Stripe environment", detail: "Missing STRIPE_SECRET_KEY." }],
    },
  }));

  assert.equal(result.ok, false);
  assert.match(result.checks.find((check) => check.label === "Stripe config launch-safe").detail, /blocking/);
});

test("launch verifier reports paused SMS as operational choice, not setup failure", () => {
  const result = analyzeLaunchCertification(readyFacts({
    settings: { sms_enabled: false },
  }));
  const sms = result.checks.find((check) => check.label === "automatic SMS mode");

  assert.equal(sms.level, "warn");
  assert.match(sms.detail, /paused by owner choice/);
  assert.equal(result.ok, true);
});

test("launch verifier keeps checkout eligibility independent from setup-fee state", () => {
  const result = analyzeLaunchCertification(readyFacts({
    account: { setup_fee_status: "refunded" },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.checkoutAllowed.ok, false, "an already active account cannot open another Checkout session");
});

test("launch verifier treats durable paid activation as authoritative", () => {
  const result = analyzeLaunchCertification(readyFacts({
    account: {
      onboarding_status: "setting_up",
      activated_at: "2026-07-17T00:00:00.000Z",
    },
  }));
  const lifecycle = result.checks.find((check) => check.label === "onboarding lifecycle");
  const blocker = result.checks.find((check) => check.label === "onboarding blocker");

  assert.equal(result.ok, true);
  assert.match(lifecycle.detail, /effective=live/);
  assert.equal(blocker.level, "pass");
});

test("launch verifier treats carrier approval as separate from call-capture readiness", () => {
  const setup = analyzeLaunchCertification(readyFacts({
    account: {
      billing_status: "not_started",
      stripe_subscription_status: null,
      onboarding_status: "setting_up",
      activated_at: null,
      first_paid_at: null,
    },
    latestLead: null,
  }));
  const carrier = analyzeLaunchCertification(readyFacts({
    account: {
      billing_status: "not_started",
      stripe_subscription_status: null,
      onboarding_status: "carrier_review",
      activated_at: null,
      first_paid_at: null,
    },
    settings: { a2p_registration_status: "in_progress" },
  }));

  assert.equal(setup.blocker, "setup");
  assert.equal(carrier.blocker, "none");
  assert.match(setup.checks.find((check) => check.label === "onboarding blocker").detail, /blocked by call setup/i);
  assert.match(carrier.checks.find((check) => check.label === "A2P\/SMS registration readiness").detail, /calls and billing remain available/i);
});

test("launch verifier accepts the account slug", () => {
  assert.deepEqual(parseLaunchArgs(["relay-nw"]), { slug: "relay-nw" });
});
