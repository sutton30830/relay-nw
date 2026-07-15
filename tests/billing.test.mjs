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

  const script = new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path });
  script.runInThisContext()(require, module, module.exports);
  return module.exports;
}

const billing = await loadTsModule("lib/billing.ts", {
  "@/lib/readiness": {},
});

function setupReadiness(overrides = {}) {
  return {
    callCaptureReady: false,
    smsRegistrationReady: false,
    ...overrides,
  };
}

function billingRecord(overrides = {}) {
  return {
    billingStatus: "not_started",
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripePriceId: null,
    trialEndsAt: null,
    billingUpdatedAt: null,
    ...overrides,
  };
}

test("billing waits while setup is not activation-ready", () => {
  const state = billing.computeBillingReadiness({
    billing: billingRecord(),
    setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: false }),
  });

  assert.equal(state.state, "setup_not_billable");
  assert.equal(state.activationReady, false);
  assert.equal(state.label, "Setup first");
});

test("account becomes ready to bill only after call capture and texting registration are ready", () => {
  const state = billing.computeBillingReadiness({
    billing: billingRecord(),
    setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: true }),
  });

  assert.equal(state.state, "ready_to_start_billing");
  assert.equal(state.activationReady, true);
  assert.equal(state.label, "Ready to bill");
});

test("active, trialing, and comped billing states are accepted without setup enforcement", () => {
  for (const billingStatus of ["active", "trialing", "comped"]) {
    const state = billing.computeBillingReadiness({
      billing: billingRecord({ billingStatus }),
      setupReadiness: setupReadiness(),
    });

    assert.equal(state.billingStatus, billingStatus);
    assert.notEqual(state.state, "billing_attention");
  }
});

test("past due and canceled are visible attention states but do not disable Relay in Phase 5A", () => {
  for (const billingStatus of ["past_due", "canceled"]) {
    const state = billing.computeBillingReadiness({
      billing: billingRecord({ billingStatus }),
      setupReadiness: setupReadiness({ callCaptureReady: true, smsRegistrationReady: true }),
    });

    assert.equal(state.state, "billing_attention");
    assert.equal(state.tone, "warn");
    assert.match(state.summary, /do not automatically disable/i);
  }
});

test("unknown billing status falls back to not_started", () => {
  assert.equal(billing.normalizeBillingStatus("surprise"), "not_started");
  assert.equal(billing.normalizeBillingStatus(null), "not_started");
});
