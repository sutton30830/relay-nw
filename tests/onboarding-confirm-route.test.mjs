import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

async function loadRoute(mocks) {
  const source = await readFile(new URL("../app/api/onboarding/confirm/route.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const require = (id) => {
    if (id in mocks) return mocks[id];
    throw new Error(`Missing mock: ${id}`);
  };
  new vm.Script(`(function(require,module,exports){${compiled}\n})`).runInThisContext()(require, module, module.exports);
  return module.exports;
}

function form(action, confirmed = true) {
  return new Request("https://relay.test/api/onboarding/confirm", {
    method: "POST",
    body: new URLSearchParams({
      action,
      ...(confirmed ? { confirmation: "confirmed" } : {}),
    }),
  });
}

function mocks({ role = "owner", ready = true, notificationSent = true } = {}) {
  const state = { confirmations: [], audits: [], loaderAccountIds: [] };
  const dependencies = {
    "next/navigation": {
      redirect: (url) => {
        const error = new Error(`REDIRECT ${url}`);
        error.url = url;
        throw error;
      },
    },
    "@/lib/auth": {
      requireAccountUser: async () => ({
        accountId: "acct-selected",
        userId: "user-owner",
        email: "owner@example.com",
        role,
      }),
    },
    "@/lib/onboarding-readiness": {
      loadAccountOnboardingReadiness: async (accountId) => {
        state.loaderAccountIds.push(accountId);
        return {
          evidence: { ownerNotificationSentAt: notificationSent ? "2026-08-05T20:00:00Z" : null },
          readiness: {
            state: ready ? "sms_delivery_verified" : "calls_verified",
            checks: [
              { key: "call_verification", status: ready ? "complete" : "pending" },
              { key: "customer_approval", status: "pending" },
            ],
          },
        };
      },
    },
    "@/lib/supabase": {
      recordCustomerOnboardingConfirmation: async (input) => state.confirmations.push(input),
      recordAccountAuditEvents: async (input) => state.audits.push(input),
    },
  };
  return { state, dependencies };
}

async function expectRedirect(promise, pattern) {
  await assert.rejects(promise, (error) => pattern.test(error.url ?? error.message));
}

test("only the authenticated account owner can record onboarding confirmations", async () => {
  const fixture = mocks({ role: "admin" });
  const { POST } = await loadRoute(fixture.dependencies);
  await expectRedirect(POST(form("approve_go_live")), /owner_required/);
  assert.equal(fixture.state.confirmations.length, 0);
  assert.equal(fixture.state.loaderAccountIds.length, 0);
});

test("go-live approval cannot skip an incomplete readiness check", async () => {
  const fixture = mocks({ ready: false });
  const { POST } = await loadRoute(fixture.dependencies);
  await expectRedirect(POST(form("approve_go_live")), /not_ready/);
  assert.deepEqual(fixture.state.loaderAccountIds, ["acct-selected"]);
  assert.equal(fixture.state.confirmations.length, 0);
});

test("owner confirmation is tenant-scoped to the selected session account", async () => {
  const fixture = mocks({ ready: true });
  const { POST } = await loadRoute(fixture.dependencies);
  await expectRedirect(POST(form("approve_go_live")), /onboarding=approved/);
  assert.equal(fixture.state.confirmations.length, 1);
  assert.equal(fixture.state.confirmations[0].accountId, "acct-selected");
  assert.equal(fixture.state.confirmations[0].userId, "user-owner");
  assert.equal(fixture.state.audits[0].accountId, "acct-selected");
});

test("notification receipt requires provider-sent evidence", async () => {
  const fixture = mocks({ notificationSent: false });
  const { POST } = await loadRoute(fixture.dependencies);
  await expectRedirect(POST(form("confirm_owner_notification")), /notification_not_sent/);
  assert.equal(fixture.state.confirmations.length, 0);
});
