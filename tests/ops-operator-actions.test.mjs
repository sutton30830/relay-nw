import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
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
  new vm.Script(`(function(require, module, exports) { ${compiled}\n})`, { filename: path })
    .runInThisContext()(require, module, module.exports);
  return module.exports;
}

const opsActions = await loadTsModule("lib/ops-actions.ts");
const customerExperienceContract = await loadTsModule("lib/customer-experience-contract.ts");
const billing = await loadTsModule("lib/billing.ts", {
  "@/lib/customer-experience-contract": customerExperienceContract,
});

function redirectRecorder(calls) {
  return {
    redirect: (url) => {
      calls.redirects.push(url);
      throw Object.assign(new Error(`REDIRECT:${url}`), { url });
    },
  };
}

async function postForm(POST, url, form) {
  const body = new FormData();
  for (const [key, value] of Object.entries(form)) body.set(key, value);
  try {
    await POST(new Request(url, { method: "POST", body }));
  } catch (error) {
    if (!String(error?.message ?? "").startsWith("REDIRECT:")) throw error;
  }
}

async function runTrialActivation({ activationResult, activationError } = {}) {
  const calls = {
    permissions: [],
    activationAccountIds: [],
    accountAudits: [],
    platformAudits: [],
    redirects: [],
  };
  const { POST } = await loadTsModule("app/api/ops/billing/activate/route.ts", {
    "next/navigation": redirectRecorder(calls),
    "@/lib/auth": {
      requirePlatformOperatorAction: async (action) => {
        calls.permissions.push(action);
        return { userId: "ops-1", email: "ops@example.com", role: "operator" };
      },
    },
    "@/lib/billing-activation": {
      activateStripeTrialForAccount: async (accountId) => {
        calls.activationAccountIds.push(accountId);
        if (activationError) throw activationError;
        return activationResult ?? {
          status: "created",
          subscriptionId: "sub_1",
          trialEndsAt: "2026-08-07T00:00:00.000Z",
        };
      },
    },
    "@/lib/ops-actions": opsActions,
    "@/lib/supabase": {
      getOpsBillingAccountBySlug: async () => ({
        accountId: "acct-authoritative",
        accountSlug: "demo",
      }),
      recordAccountAuditEvents: async (input) => calls.accountAudits.push(input),
      recordPlatformAuditEvent: async (input) => calls.platformAudits.push(input),
    },
  });
  await postForm(POST, "http://localhost/api/ops/billing/activate", {
    account_slug: "demo",
    account_id: "acct-attacker",
    billing_status: "active",
  });
  return calls;
}

test("operator trial activation uses the account lookup and the Phase 1 idempotent operation only", async () => {
  const calls = await runTrialActivation();
  assert.deepEqual(calls.permissions, [opsActions.OPS_ACTIONS.trialActivate]);
  assert.deepEqual(calls.activationAccountIds, ["acct-authoritative"]);
  assert.equal(calls.accountAudits.length, 1);
  assert.equal(calls.platformAudits.length, 1);
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?billing_action=trial_started");

  const source = await readFile(
    new URL("../app/api/ops/billing/activate/route.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /updateAccountBillingRecord|billingStatus\s*:/);
});

test("Stripe activation failure is visible and creates no success audit or local state", async () => {
  const calls = await runTrialActivation({
    activationError: new Error("Stripe unavailable after request"),
  });
  assert.deepEqual(calls.accountAudits, []);
  assert.deepEqual(calls.platformAudits, []);
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?billing_action=activation_failed");
});

async function runNumberAssignment({ action = "attach_existing", configureError = null } = {}) {
  const calls = {
    permissions: [],
    configured: [],
    assignments: [],
    redirects: [],
  };
  const { POST } = await loadTsModule("app/api/ops/twilio/assign/route.ts", {
    "next/navigation": redirectRecorder(calls),
    "@/lib/auth": {
      requirePlatformOperatorAction: async (permission) => {
        calls.permissions.push(permission);
        return { userId: "ops-1", email: "ops@example.com", role: "operator" };
      },
    },
    "@/lib/ops-actions": opsActions,
    "@/lib/twilio": {
      configureExistingRelayNumber: async (phoneNumber) => {
        calls.configured.push(phoneNumber);
        if (configureError) throw configureError;
        return { sid: "PN_owned", phoneNumber };
      },
    },
    "@/lib/supabase": {
      getOpsBillingAccountBySlug: async () => ({
        accountId: "acct-1",
        accountSlug: "demo",
      }),
      assignPrimaryAccountPhoneNumber: async (input) => {
        calls.assignments.push(input);
        return { numberChanged: true };
      },
      recordAccountAuditEvents: async () => {},
      recordPlatformAuditEvent: async () => {},
    },
  });
  await postForm(POST, "http://localhost/api/ops/twilio/assign", {
    account_slug: "demo",
    phone_number: "+12065550123",
    action,
  });
  return calls;
}

test("Operations can attach only an already-owned Twilio number", async () => {
  const purchase = await runNumberAssignment({ action: "purchase" });
  assert.deepEqual(purchase.configured, []);
  assert.deepEqual(purchase.assignments, []);
  assert.equal(purchase.redirects.at(-1), "/ops/accounts/demo?number=invalid_action");

  const attach = await runNumberAssignment();
  assert.deepEqual(attach.permissions, [opsActions.OPS_ACTIONS.assignExistingNumber]);
  assert.deepEqual(attach.configured, ["+12065550123"]);
  assert.equal(attach.assignments.length, 1);
});

test("Twilio failure is visible and cannot create favorable local assignment state", async () => {
  const calls = await runNumberAssignment({
    configureError: new Error("Twilio number is not owned"),
  });
  assert.deepEqual(calls.assignments, []);
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?number=failed");
});

async function runAccountControl({
  control = "pause_paid_service",
  role = "super_admin",
  technicalStatus = "live",
  accountStatus = "active",
  stripeSubscriptionStatus = "active",
  stateError = null,
  includeConfirmation = true,
} = {}) {
  const calls = {
    permissions: [],
    accountAudits: [],
    platformAudits: [],
    stateUpdates: [],
    redirects: [],
  };
  const { POST } = await loadTsModule("app/api/ops/calls/route.ts", {
    "next/navigation": redirectRecorder(calls),
    "@/lib/auth": {
      requirePlatformOperatorAction: async (permission) => {
        calls.permissions.push(permission);
        if (!opsActions.canPerformOpsAction(role, permission)) {
          calls.redirects.push("/leads?error=ops_read_only");
          throw Object.assign(new Error("REDIRECT:/leads?error=ops_read_only"), {
            url: "/leads?error=ops_read_only",
          });
        }
        return { userId: "ops-1", email: "ops@example.com", role };
      },
    },
    "@/lib/ops-actions": opsActions,
    "@/lib/supabase": {
      getOpsAccountBySlug: async () => ({
        accountId: "acct-1",
        accountSlug: "demo",
        businessName: "Demo Plumbing",
        technicalStatus,
        accountStatus,
      }),
      getOpsBillingAccountBySlug: async () => ({
        accountId: "acct-1",
        accountSlug: "demo",
        stripeSubscriptionStatus,
      }),
      recordAccountAuditEvents: async (input) => calls.accountAudits.push(input),
      recordPlatformAuditEvent: async (input) => calls.platformAudits.push(input),
      updateAccountOperationalState: async (input) => {
        calls.stateUpdates.push(input);
        if (stateError) throw stateError;
      },
    },
  });
  await postForm(POST, "http://localhost/api/ops/calls", {
    account_slug: "demo",
    account_control: control,
    reason: "Customer requested an explicit service hold",
    ...(includeConfirmation ? { confirmation: "confirmed" } : {}),
  });
  return calls;
}

test("paid-service pause is super-admin-only, confirmed, and audited in both scopes", async () => {
  const operator = await runAccountControl({ role: "operator" });
  assert.deepEqual(operator.stateUpdates, []);
  assert.equal(operator.redirects.at(-1), "/leads?error=ops_read_only");

  const unconfirmed = await runAccountControl({ includeConfirmation: false });
  assert.deepEqual(unconfirmed.stateUpdates, []);
  assert.deepEqual(unconfirmed.accountAudits, []);
  assert.deepEqual(unconfirmed.platformAudits, []);
  assert.equal(unconfirmed.redirects.at(-1), "/ops/accounts/demo?calls=confirmation_required");

  const superAdmin = await runAccountControl();
  assert.deepEqual(superAdmin.permissions, [opsActions.OPS_ACTIONS.paidServicePause]);
  assert.equal(superAdmin.accountAudits.length, 1);
  assert.equal(superAdmin.platformAudits.length, 1);
  assert.deepEqual(superAdmin.stateUpdates, [{
    accountId: "acct-1",
    accountStatus: "paused",
    technicalStatus: "paused",
  }]);
  assert.equal(superAdmin.redirects.at(-1), "/ops/accounts/demo?calls=saved");
});

test("account-control persistence failure stays visible and never changes Stripe state", async () => {
  const calls = await runAccountControl({
    stateError: new Error("database unavailable"),
  });
  assert.equal(calls.redirects.at(-1), "/ops/accounts/demo?calls=save_failed");
  const source = await readFile(
    new URL("../app/api/ops/calls/route.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /updateAccountBillingRecord|stripeSubscriptionStatus\s*:/);
});

test("A2P synchronization cannot activate billing and refund execution is absent", async () => {
  const carrier = await readFile(
    new URL("../app/api/ops/carrier/route.ts", import.meta.url),
    "utf8",
  );
  const accountPage = await readFile(
    new URL("../app/ops/accounts/[id]/page.tsx", import.meta.url),
    "utf8",
  );
  const stripe = await readFile(
    new URL("../lib/stripe-billing.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(carrier, /activateStripeTrialForAccount|next\/server|billing_status/);
  assert.match(carrier, /a2p_registration_status/);
  assert.match(accountPage, /Open payment in Stripe/);
  assert.doesNotMatch(accountPage, /api\/ops\/billing\/refund|Refund remaining setup fee/);
  assert.doesNotMatch(stripe, /createStripeRefund|STRIPE_API_BASE}\/refunds/);
  await assert.rejects(
    access(new URL("../app/api/ops/billing/refund/route.ts", import.meta.url)),
  );
});

async function runKickoff({
  ownerEmail = "owner@example.com",
  accountOverrides = {},
} = {}) {
  const calls = {
    setupFeeCheckouts: [],
    cardCheckouts: [],
    emails: [],
    updates: [],
    redirects: [],
    responseLocation: null,
  };
  const account = {
    accountId: "acct-1",
    accountSlug: "demo",
    commercialOffer: "standard",
    billingPolicy: "standard",
    setupFeeStatus: "due",
    setupFeeCents: 15000,
    setupFeeRefundedAt: null,
    setupFeeCheckoutSessionId: null,
    billingSetupCheckoutSessionId: null,
    stripeCustomerId: null,
    stripeDefaultPaymentMethodId: null,
    firstPaidAt: null,
    ...accountOverrides,
  };
  const { POST } = await loadTsModule("app/api/ops/kickoff/route.ts", {
    "next/navigation": redirectRecorder(calls),
    "@/lib/auth": {
      requirePlatformOperatorAction: async () => ({
        userId: "ops-1",
        email: "ops@example.com",
        role: "operator",
      }),
    },
    "@/lib/billing": billing,
    "@/lib/customer-experience-contract": customerExperienceContract,
    "@/lib/email": {
      notifyOwnerKickoffPayment: async (input) => {
        calls.emails.push(input);
        return { sent: true };
      },
    },
    "@/lib/ops-actions": opsActions,
    "@/lib/stripe-billing": {
      retrieveStripeCheckoutSession: async () => {
        throw new Error("unexpected Checkout retrieval");
      },
      createStripeSetupFeeCheckoutSession: async (input) => {
        calls.setupFeeCheckouts.push(input);
        return { id: "cs_fee", url: "https://stripe.test/fee" };
      },
      createStripePaymentMethodCheckoutSession: async (input) => {
        calls.cardCheckouts.push(input);
        return { id: "cs_card", url: "https://stripe.test/card" };
      },
    },
    "@/lib/supabase": {
      getOpsBillingAccountBySlug: async () => account,
      getAccountConfigByAccountId: async () => ({
        businessName: "Demo Plumbing",
        ownerEmail,
      }),
      updateAccountBillingRecord: async (accountId, update) => {
        calls.updates.push({ accountId, update });
      },
      recordAccountAuditEvents: async () => {},
      recordPlatformAuditEvent: async () => {},
    },
  });
  const body = new FormData();
  body.set("account_slug", "demo");
  body.set("action", "send_invoice");
  try {
    const response = await POST(new Request("https://relay.test/api/ops/kickoff", {
      method: "POST",
      body,
    }));
    calls.responseLocation = response.headers.get("location");
  } catch (error) {
    if (!String(error?.message ?? "").startsWith("REDIRECT:")) throw error;
  }
  return calls;
}

test("kickoff links go only to the customer and cannot double-charge a settled setup fee", async () => {
  const missingOwner = await runKickoff({ ownerEmail: null });
  assert.deepEqual(missingOwner.setupFeeCheckouts, []);
  assert.deepEqual(missingOwner.cardCheckouts, []);
  assert.deepEqual(missingOwner.emails, []);
  assert.equal(missingOwner.redirects.at(-1), "/ops/accounts/demo?kickoff=owner_email_missing");

  const paidNeedsCard = await runKickoff({
    accountOverrides: {
      setupFeeStatus: "paid",
      firstPaidAt: "2026-07-23T00:00:00.000Z",
    },
  });
  assert.deepEqual(paidNeedsCard.setupFeeCheckouts, []);
  assert.equal(paidNeedsCard.cardCheckouts.length, 1);
  assert.equal(paidNeedsCard.emails[0].to, "owner@example.com");
  assert.equal(paidNeedsCard.emails[0].setupFeeAlreadyPaid, true);

  const paidAndReady = await runKickoff({
    accountOverrides: {
      setupFeeStatus: "paid",
      firstPaidAt: "2026-07-23T00:00:00.000Z",
      stripeDefaultPaymentMethodId: "pm_ready",
    },
  });
  assert.deepEqual(paidAndReady.setupFeeCheckouts, []);
  assert.deepEqual(paidAndReady.cardCheckouts, []);
  assert.equal(paidAndReady.responseLocation, "https://relay.test/ops/accounts/demo?kickoff=already_ready");
});

test("a founding-pilot card link requires the audited waiver state", async () => {
  const incomplete = await runKickoff({
    accountOverrides: {
      commercialOffer: "founding_pilot",
      billingPolicy: "standard",
    },
  });
  assert.deepEqual(incomplete.cardCheckouts, []);
  assert.equal(
    incomplete.responseLocation,
    "https://relay.test/ops/accounts/demo?kickoff=commercial_terms_incomplete",
  );

  const waived = await runKickoff({
    accountOverrides: {
      commercialOffer: "founding_pilot",
      billingPolicy: "setup_fee_waived",
      setupFeeStatus: "waived",
    },
  });
  assert.equal(waived.cardCheckouts.length, 1);
  assert.equal(waived.cardCheckouts[0].trialDays, 30);
  assert.equal(waived.emails[0].feeWaived, true);
});
