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
