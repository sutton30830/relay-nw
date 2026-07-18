import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { analyzeLaunchCertification, parseLaunchArgs } from "../scripts/verify-launch.mjs";
import {
  billingControlRehearsalSteps,
  canRehearseBillingControls,
  isScratchBillingSlug,
  runBillingControlsRehearsal,
  snapshotBillingRecord,
} from "../scripts/verify-billing-controls.mjs";

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
    latestLead: Object.hasOwn(overrides, "latestLead") ? overrides.latestLead : null,
    lastPassedForwarding: Object.hasOwn(overrides, "lastPassedForwarding")
      ? overrides.lastPassedForwarding
      : { id: "fh_1", completed_at: "2026-08-01T00:00:00.000Z" },
    billingConfigResult: overrides.billingConfigResult ?? {
      ok: true,
      checks: [
        { ok: true, level: "pass", label: "Stripe environment", detail: "ok" },
      ],
    },
  };
}

async function postOperatorDeadline({
  account = {
    accountId: "acct_1",
    accountSlug: "demo",
    onboardingStatus: "requirements_needed",
  },
  operatorThrows = false,
} = {}) {
  const calls = { marks: [] };
  class RedirectError extends Error {
    constructor(url) {
      super(url);
      this.url = url;
    }
  }

  const { POST } = await loadTsModule("app/api/ops/onboarding-deadlines/route.ts", {
    "next/navigation": {
      redirect: (url) => {
        throw new RedirectError(url);
      },
    },
    "@/lib/auth": {
      requireRelayOperator: async () => {
        if (operatorThrows) throw new Error("not operator");
        return { userId: "user_1", email: "ops@example.com" };
      },
    },
    "@/lib/supabase": {
      canMoveAccountToCustomerDelay: (status, lifecycleDates) => (
        !lifecycleDates?.activatedAt &&
        !lifecycleDates?.firstPaidAt &&
        !lifecycleDates?.guaranteeEndsAt &&
        (
          status === "requirements_needed" ||
          status === "waiting_on_customer" ||
          status === "paused_incomplete" ||
          status === "closed_incomplete"
        )
      ),
      getOpsOnboardingAccountBySlug: async () => account,
      markAccountRequirementsRequested: async (input) => {
        calls.marks.push(input);
        return { requirementsDueAt: "2026-08-15T00:00:00.000Z" };
      },
    },
  });

  const form = new FormData();
  form.set("account_slug", "demo");

  try {
    await POST(new Request("https://example.com/api/ops/onboarding-deadlines", {
      method: "POST",
      body: form,
    }));
    throw new Error("expected redirect");
  } catch (error) {
    if (error instanceof RedirectError) {
      return { redirect: error.url, calls };
    }
    throw error;
  }
}

test("operator can start customer-delay clock", async () => {
  const result = await postOperatorDeadline();
  assert.match(result.redirect, /onboarding=requested/);
  assert.equal(result.calls.marks.length, 1);
  assert.equal(result.calls.marks[0].previousOnboardingStatus, "requirements_needed");
});

test("operator can reopen paused_incomplete with a new due date", async () => {
  const result = await postOperatorDeadline({
    account: { accountId: "acct_1", accountSlug: "demo", onboardingStatus: "paused_incomplete" },
  });
  assert.match(result.redirect, /onboarding=reopened/);
  assert.equal(result.calls.marks[0].previousOnboardingStatus, "paused_incomplete");
});

test("operator can reopen closed_incomplete with a new due date", async () => {
  const result = await postOperatorDeadline({
    account: { accountId: "acct_1", accountSlug: "demo", onboardingStatus: "closed_incomplete" },
  });
  assert.match(result.redirect, /onboarding=reopened/);
  assert.equal(result.calls.marks[0].previousOnboardingStatus, "closed_incomplete");
});

test("non-operator cannot mutate onboarding deadlines", async () => {
  await assert.rejects(
    postOperatorDeadline({ operatorThrows: true }),
    /not operator/,
  );
});

test("carrier_review is not treated as customer delay", async () => {
  const result = await postOperatorDeadline({
    account: { accountId: "acct_1", accountSlug: "demo", onboardingStatus: "carrier_review" },
  });
  assert.match(result.redirect, /onboarding=not_customer_delay/);
  assert.equal(result.calls.marks.length, 0);
});

test("activated account is not moved back into customer delay", async () => {
  const result = await postOperatorDeadline({
    account: {
      accountId: "acct_1",
      accountSlug: "demo",
      onboardingStatus: "waiting_on_customer",
      activatedAt: "2026-07-01T00:00:00.000Z",
    },
  });
  assert.match(result.redirect, /onboarding=not_customer_delay/);
  assert.equal(result.calls.marks.length, 0);
});

test("reopening code does not reset durable activation, first-paid, or guarantee dates", async () => {
  const accountStore = await readFile(new URL("../lib/supabase/accounts.ts", import.meta.url), "utf8");
  const helperBody = accountStore.slice(accountStore.indexOf("export async function markAccountRequirementsRequested"));

  assert.match(helperBody, /updateAccountBillingRecord\(accountId,\s*\{\s*onboardingStatus: "waiting_on_customer",\s*requirementsDueAt,/);
  assert.doesNotMatch(helperBody, /activatedAt\s*:/);
  assert.doesNotMatch(helperBody, /firstPaidAt\s*:/);
  assert.doesNotMatch(helperBody, /guaranteeEndsAt\s*:/);
});

test("launch verifier passes for a ready account", () => {
  const result = analyzeLaunchCertification(readyFacts());
  assert.equal(result.ok, true);
});

test("launch verifier fails for incomplete setup", () => {
  const result = analyzeLaunchCertification(readyFacts({
    lastPassedForwarding: null,
    account: { onboarding_status: "ready_for_live_test", billing_status: "not_started", stripe_subscription_status: null },
  }));

  assert.equal(result.ok, false);
  assert.match(result.checks.find((check) => check.label === "call capture readiness").detail, /needs a passed forwarding/);
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

test("launch verifier reconciles stale customer-delay status for active accounts", () => {
  const result = analyzeLaunchCertification(readyFacts({
    account: {
      onboarding_status: "waiting_on_customer",
      requirements_due_at: "2026-07-31T00:00:00.000Z",
      activated_at: "2026-07-17T00:00:00.000Z",
    },
  }));
  const lifecycle = result.checks.find((check) => check.label === "onboarding lifecycle");
  const blocker = result.checks.find((check) => check.label === "onboarding blocker");

  assert.equal(result.ok, true);
  assert.match(lifecycle.detail, /effective=activated/);
  assert.equal(blocker.level, "pass");
});

test("launch verifier distinguishes customer delay from carrier delay", () => {
  const customer = analyzeLaunchCertification(readyFacts({
    account: {
      billing_status: "not_started",
      stripe_subscription_status: null,
      onboarding_status: "waiting_on_customer",
      activated_at: null,
      first_paid_at: null,
    },
    lastPassedForwarding: null,
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

  assert.equal(customer.blocker, "customer_delay");
  assert.equal(carrier.blocker, "carrier_delay");
  assert.match(customer.checks.find((check) => check.label === "onboarding blocker").detail, /customer delay/);
  assert.match(carrier.checks.find((check) => check.label === "onboarding blocker").detail, /carrier\/A2P delay/);
});

test("launch verifier parses optional scratch billing-control rehearsal args", () => {
  assert.deepEqual(
    parseLaunchArgs(["relay-nw", "--billing-controls", "scratch-launch"]),
    { slug: "relay-nw", billingControlsSlug: "scratch-launch" },
  );
  assert.deepEqual(
    parseLaunchArgs(["--billing-controls", "scratch-launch", "relay-nw"]),
    { slug: "relay-nw", billingControlsSlug: "scratch-launch" },
  );
});

test("billing-control rehearsal refuses non-scratch and live Stripe accounts", () => {
  assert.equal(isScratchBillingSlug("scratch-launch"), true);
  assert.equal(isScratchBillingSlug("relay-nw"), false);
  assert.deepEqual(canRehearseBillingControls(null), { ok: false, reason: "missing_account" });
  assert.deepEqual(canRehearseBillingControls({ slug: "relay-nw" }), { ok: false, reason: "not_scratch" });
  assert.deepEqual(
    canRehearseBillingControls({
      slug: "scratch-launch",
      stripe_subscription_id: "sub_live",
      stripe_subscription_status: "active",
    }),
    { ok: false, reason: "live_stripe_subscription" },
  );
});

test("billing-control rehearsal snapshots only billing fields", () => {
  assert.deepEqual(
    snapshotBillingRecord({
      slug: "scratch-launch",
      billing_status: "trialing",
      trial_ends_at: "2026-07-20T00:00:00.000Z",
      cancel_at_period_end: true,
      billing_attention_since: null,
      stripe_customer_id: "cus_123",
      stripe_subscription_id: null,
      stripe_subscription_status: null,
      name: "Should not be in snapshot",
    }),
    {
      billing_status: "trialing",
      trial_ends_at: "2026-07-20T00:00:00.000Z",
      cancel_at_period_end: true,
      billing_attention_since: null,
      stripe_customer_id: "cus_123",
      stripe_subscription_id: null,
      stripe_subscription_status: null,
    },
  );
});

test("billing-control rehearsal steps cover comp, uncomp, trial grant, and expiry flip", () => {
  const steps = billingControlRehearsalSteps(new Date("2026-07-18T12:00:00.000Z"));

  assert.deepEqual(steps.map((step) => step.key), ["comp", "uncomp", "grant_trial", "expiry_flip"]);
  assert.equal(steps[0].update.billing_status, "comped");
  assert.equal(steps[1].update.billing_status, "not_started");
  assert.equal(steps[2].update.billing_status, "trialing");
  assert.equal(steps[3].update.billing_status, "past_due");
  assert.match(steps[3].auditSummary, /Call capture remains on/);
});

test("billing-control rehearsal mutates only a scratch account and restores original billing state", async () => {
  const calls = { updates: [], audits: [] };
  let account = {
    id: "acct_scratch",
    slug: "scratch-launch",
    billing_status: "not_started",
    trial_ends_at: null,
    cancel_at_period_end: false,
    billing_attention_since: null,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    stripe_subscription_status: null,
  };
  const store = {
    loadAccount: async () => ({ ...account }),
    updateAccount: async (_accountId, update) => {
      calls.updates.push(update);
      account = { ...account, ...update };
    },
    recordAudit: async (_accountId, action, summary) => {
      calls.audits.push({ action, summary });
    },
  };

  const result = await runBillingControlsRehearsal({
    slug: "scratch-launch",
    store,
    now: new Date("2026-07-18T12:00:00.000Z"),
  });

  assert.equal(result.ok, true);
  assert.equal(calls.audits.length, 4);
  assert.deepEqual(calls.audits.map((audit) => audit.action), [
    "billing.operator.comp",
    "billing.operator.uncomp",
    "billing.operator.grant_trial",
    "billing.trial.expired",
  ]);
  assert.equal(calls.updates.at(-1).billing_status, "not_started");
  assert.equal(calls.updates.at(-1).trial_ends_at, null);
  assert.match(result.checks.find((check) => check.label === "scratch account restored").detail, /restored/);
});
